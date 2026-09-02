/**
 * Резервирование средств под вызов (ADR-0010).
 *
 * **Резерв не меняет остаток и не создаёт проводок.** Он ограничивает *доступную* сумму:
 *
 *     доступно = остаток + овердрафт − сумма действующих резервов
 *
 * Так инвариант DOMAIN.md «баланс клиента не уходит ниже разрешённого овердрафта»
 * соблюдается **до** звонка, а не проверкой после — сто одновременных вызовов при остатке
 * на одну минуту иначе все прошли бы проверку и все состоялись.
 *
 * Обратное решение — проводить резерв через журнал — давало бы на каждый несостоявшийся
 * вызов пару записей туда и обратно: проводки неизменяемы, освободить их можно только
 * встречной. Журнал распух бы шумом, в котором тонут настоящие списания.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  Money,
  notFound,
  validationFailed,
  type Id,
  type MoneyAmount,
} from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { BillingRepository, type Executor } from './billing.repository.js';
import { ReservationRepository, type ReservationRow } from './reservation.repository.js';

/** Сколько просроченных резервов освобождается за один проход фоновой уборки. */
const EXPIRY_SWEEP_LIMIT = 500;

export interface AvailableFunds {
  readonly balance: MoneyAmount;
  readonly overdraftLimit: MoneyAmount;
  readonly held: MoneyAmount;
  /** `остаток + овердрафт − резервы`. Может быть отрицательным. */
  readonly available: MoneyAmount;
}

@Injectable()
export class ReservationService {
  private readonly logger: Logger;

  constructor(
    private readonly reservations: ReservationRepository,
    private readonly billing: BillingRepository,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('reservations');
  }

  /**
   * Придерживает сумму под вызов.
   *
   * Счёт клиента блокируется на время проверки: без блокировки два одновременных вызова
   * оба прочитают один и тот же остаток, оба увидят, что средств хватает, и оба пройдут.
   * Блокировка именно счёта, а не таблицы резервов, потому что ограничение — на клиента.
   */
  async hold(input: {
    callId: Id<'call'>;
    clientId: Id<'client'>;
    amount: MoneyAmount;
  }): Promise<ReservationRow> {
    if (Money.compare(input.amount, Money.ZERO) <= 0) {
      throw validationFailed('Резерв должен быть больше нуля');
    }

    return this.billing.db.transaction(async (tx) => {
      const funds = await this.availableWithin(input.clientId, tx);

      if (Money.compare(funds.available, input.amount) < 0) {
        throw conflict('Недостаточно средств с учётом действующих резервов', {
          details: {
            available: Money.format(funds.available),
            required: Money.format(input.amount),
            held: Money.format(funds.held),
          },
        });
      }

      return this.reservations.insert(
        {
          callId: input.callId,
          clientId: input.clientId,
          amount: input.amount,
          expiresAt: new Date(Date.now() + this.config.RESERVATION_TTL_SECONDS * 1000),
        },
        tx,
      );
    });
  }

  /**
   * Закрывает резерв после завершения вызова.
   *
   * Само списание фактической суммы делает `BillingService` проводкой — здесь только
   * снимается удержание. Разделение намеренное: резерв про доступность, проводка
   * про деньги, и смешивать их значит однажды списать дважды.
   */
  async capture(callId: Id<'call'>): Promise<ReservationRow> {
    return this.settle(callId, 'captured');
  }

  /** Освобождает резерв: вызов не состоялся. */
  async release(callId: Id<'call'>): Promise<ReservationRow> {
    return this.settle(callId, 'released');
  }

  private async settle(
    callId: Id<'call'>,
    status: 'captured' | 'released',
  ): Promise<ReservationRow> {
    const existing = await this.reservations.findByCall(callId);
    if (existing === undefined) throw notFound('Резерв по вызову не найден');

    const settled = await this.reservations.settle(
      existing.id,
      status,
      new Date(),
      this.billing.db,
    );
    if (settled === undefined) {
      // Резерв закрыт кем-то ещё: пришедший CDR и фоновое освобождение по сроку могли
      // сойтись на одном резерве. Закрывается он ровно один раз — это не ошибка вызова,
      // но и молчать нельзя: расхождение сроков стоит увидеть.
      this.logger.warn('Резерв уже был закрыт', {
        reservation_id: existing.id,
        call_id: callId,
        requested: status,
        actual: existing.status,
      });
      return existing;
    }
    return settled;
  }

  /** Доступная сумма клиента с учётом действующих резервов. */
  async available(clientId: Id<'client'>): Promise<AvailableFunds> {
    return this.availableWithin(clientId, this.billing.db);
  }

  private async availableWithin(
    clientId: Id<'client'>,
    executor: Executor,
  ): Promise<AvailableFunds> {
    const client = await this.billing.findClient(clientId);
    if (client === undefined) throw notFound('Клиент не найден');

    const account = await this.billing.findAccount('client', clientId, 'RUB', executor);
    if (account === undefined) throw notFound('Счёт клиента не найден');

    // Блокировка счёта до конца транзакции. Вне транзакции это обычное чтение и никого
    // не задерживает; внутри — сериализует одновременные резервы одного клиента.
    await this.billing.lockAccounts([account.id], executor);

    const held = Money.fromMicros(await this.reservations.heldTotal(clientId, executor));
    const available = Money.subtract(Money.add(account.balance, client.overdraftLimit), held);

    return { balance: account.balance, overdraftLimit: client.overdraftLimit, held, available };
  }

  /**
   * Освобождает просроченные резервы.
   *
   * Страховка от потерянного CDR: без неё замороженный остаток не размораживается никогда,
   * клиент перестаёт звонить, и причина не видна ниоткуда. Вызывается фоновой задачей;
   * пока её нет — при запросе доступной суммы.
   */
  async releaseExpired(now: Date = new Date()): Promise<number> {
    const expired = await this.reservations.findExpired(now, EXPIRY_SWEEP_LIMIT);
    let released = 0;

    for (const reservation of expired) {
      const settled = await this.reservations.settle(
        reservation.id,
        'released',
        now,
        this.billing.db,
      );
      if (settled !== undefined) released += 1;
    }

    if (released > 0) {
      // Просроченный резерв означает потерянный или задержавшийся CDR. Это не норма,
      // и рост числа таких освобождений — повод разбираться с узлом, а не с балансом.
      this.logger.warn('Освобождены просроченные резервы', { count: released });
    }
    return released;
  }

  /**
   * Резерв по вызову, если он есть.
   *
   * Отсутствие — не всегда ошибка: вызов мог не дойти до резервирования, отказавшись
   * раньше. Поэтому приёму CDR нужен вопрос «есть ли резерв», а не только требование.
   */
  async findByCall(callId: Id<'call'>): Promise<ReservationRow | undefined> {
    return this.reservations.findByCall(callId);
  }
}
