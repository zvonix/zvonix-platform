/**
 * Резервы средств под вызов (ADR-0010) — **доживающие**.
 *
 * С [ADR-0125](../../../../../docs/adr/0125-dengi-na-zvonok-bez-rezerva.md) новые резервы не создаются: звонок
 * начинается по доступному за вычетом стоимости идущих разговоров, а деньги держит проверка во время разговора.
 * Здесь остаются закрытие резервов, созданных до выкладки (CDR и срок), и доступная сумма с их учётом.
 *
 * **Резерв не меняет остаток и не создаёт проводок.** Он ограничивает *доступную* сумму:
 *
 *     доступно = остаток + овердрафт − сумма действующих резервов
 *
 * Пока действующих резервов не осталось, доступное — это остаток плюс разрешённый минус.
 *
 * Обратное решение — проводить резерв через журнал — давало бы на каждый несостоявшийся
 * вызов пару записей туда и обратно: проводки неизменяемы, освободить их можно только
 * встречной. Журнал распух бы шумом, в котором тонут настоящие списания.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Money, notFound, type Id, type MoneyAmount } from '@zvonix/shared';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { BillingRepository } from './billing.repository.js';
import { ReservationRepository, type ReservationRow } from './reservation.repository.js';

/** Сколько просроченных резервов освобождается за один проход фоновой уборки. */
export const EXPIRY_SWEEP_LIMIT = 500;

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
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('reservations');
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
    const executor = this.billing.db;
    const client = await this.billing.findClient(clientId);
    if (client === undefined) throw notFound('Клиент не найден');

    const account = await this.billing.findAccount('client', clientId, 'RUB', executor);
    if (account === undefined) throw notFound('Счёт клиента не найден');

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
