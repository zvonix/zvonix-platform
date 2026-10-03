/**
 * Заявки на пополнение счёта и их исход
 * ([ADR-0064](../../../../../docs/adr/0064-platezhi-karkas.md)).
 *
 * Здесь решается только судьба заявки. Деньги на счёт кладёт `BillingService` проводкой
 * с ключом `payment:<идентификатор>` — **ровно один раз**, как бы ни сложились повторы
 * и гонки: платёж переходит в `succeeded` той же транзакцией, что и проводка.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  Money,
  notFound,
  PAYMENT_MAX_RUBLES,
  PAYMENT_MIN_RUBLES,
  PAYMENT_PENDING_MAX,
  validationFailed,
  type Id,
  type MoneyAmount,
  type PaymentProviderId,
  type UserRole,
} from '@zvonix/shared';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingService } from '../billing/billing.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ManualPaymentProvider, type PaymentProvider } from './payment-provider.js';
import { PaymentsRepository, type PaymentFilter, type PaymentRow } from './payments.repository.js';

/** Кто действует: учётная запись и роль — для журнала. */
export interface PaymentActor {
  readonly userId: Id<'user'>;
  readonly role: UserRole;
}

@Injectable()
export class PaymentsService {
  private readonly logger: Logger;
  private readonly providers: ReadonlyMap<PaymentProviderId, PaymentProvider>;

  constructor(
    private readonly repository: PaymentsRepository,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    manual: ManualPaymentProvider,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('payments');
    // Единственное место, где перечислены способы. Новая платёжная система — здесь.
    this.providers = new Map<PaymentProviderId, PaymentProvider>([[manual.id, manual]]);
  }

  /** Реквизиты для перевода; пусто — заявки не принимаются. */
  async instructions(): Promise<string> {
    return (await this.settings.payments()).manualInstructions;
  }

  /** Новая заявка клиента. */
  async create(
    clientId: Id<'client'>,
    actorUserId: Id<'user'>,
    input: { amount: MoneyAmount; comment: string | undefined },
  ): Promise<PaymentRow> {
    if ((await this.instructions()) === '') {
      throw conflict('Приём заявок на пополнение пока не настроен — обратитесь в поддержку');
    }
    const min = Money.fromMajorUnits(String(PAYMENT_MIN_RUBLES));
    const max = Money.fromMajorUnits(String(PAYMENT_MAX_RUBLES));
    if (Money.compare(input.amount, min) < 0 || Money.compare(input.amount, max) > 0) {
      throw validationFailed(
        `Сумма заявки — от ${String(PAYMENT_MIN_RUBLES)} до ${String(PAYMENT_MAX_RUBLES)} ₽`,
      );
    }
    if ((await this.repository.countPending(clientId)) >= PAYMENT_PENDING_MAX) {
      throw conflict(
        `Открытых заявок уже ${String(PAYMENT_PENDING_MAX)}: дождитесь подтверждения или отзовите лишние`,
      );
    }

    const payment = await this.repository.insert({
      clientId,
      provider: 'manual',
      amount: input.amount,
      comment: input.comment ?? null,
      createdByUserId: actorUserId,
    });
    // Способ мог бы вернуть ссылку на оплату; ручной не возвращает ничего.
    await this.providerOf(payment).begin(payment);
    return payment;
  }

  /** Решённые заявки (подтверждённые и отклонённые) за период — для письма клиенту. */
  resolvedSince(since: Date, limit: number): Promise<PaymentRow[]> {
    return this.repository.listResolvedSince(since, limit);
  }

  list(filter: PaymentFilter): Promise<{ rows: PaymentRow[]; total: number }> {
    return this.repository.list(filter);
  }

  /** Отзыв заявки клиентом. Чужая — «не найдена», а не «нельзя»: существование не выдаётся. */
  async cancelOwn(
    paymentId: Id<'payment'>,
    clientId: Id<'client'>,
    userId: Id<'user'>,
  ): Promise<PaymentRow> {
    const payment = await this.repository.findById(paymentId);
    if (payment?.clientId !== clientId) throw notFound('Заявка не найдена');
    if (payment.status === 'cancelled') return payment;

    const cancelled = await this.repository.resolve(paymentId, {
      status: 'cancelled',
      resolvedByUserId: userId,
    });
    if (cancelled === undefined) throw conflict('Заявка уже решена и отозвана быть не может');
    return cancelled;
  }

  /**
   * Подтверждение: деньги пришли. Зачисляет проводкой и закрывает заявку **одной транзакцией**.
   *
   * Повтор безопасен: проводка идемпотентна по ключу, а уже зачисленная заявка возвращается
   * как есть — администратор, нажавший дважды, второй раз ничего не начислит.
   */
  async confirm(
    paymentId: Id<'payment'>,
    actor: PaymentActor,
    received: MoneyAmount | undefined,
  ): Promise<PaymentRow> {
    const payment = await this.require(paymentId);
    if (payment.status === 'succeeded') return payment;
    if (payment.status !== 'pending') {
      throw conflict('Заявка уже закрыта: подтвердить её нельзя');
    }

    const credited = received ?? payment.amount;
    const max = Money.fromMajorUnits(String(PAYMENT_MAX_RUBLES));
    if (Money.compare(credited, Money.ZERO) <= 0 || Money.compare(credited, max) > 0) {
      throw validationFailed('Сумма зачисления вне допустимых границ');
    }

    await this.billing.depositToClient({
      clientId: payment.clientId,
      amount: credited,
      idempotencyKey: `payment:${payment.id}`,
      description: `Пополнение по заявке ${payment.id.slice(0, 8)}`,
      actorUserId: actor.userId,
      alsoInTransaction: async (tx) => {
        const resolved = await this.repository.resolve(
          payment.id,
          { status: 'succeeded', receivedAmount: credited, resolvedByUserId: actor.userId },
          tx,
        );
        // Заявку успели отозвать или отклонить между проверкой и проводкой: деньги не
        // кладём — исключение откатывает проводку вместе с этой транзакцией.
        if (resolved === undefined) throw conflict('Заявка изменилась: обновите страницу');
        await this.audit.record(
          {
            action: 'payment.confirmed',
            entityType: 'payment',
            entityId: payment.id,
            actorUserId: actor.userId,
            actorRole: actor.role,
            before: { status: 'pending', amount: Money.format(payment.amount) },
            after: { status: 'succeeded', received_amount: Money.format(credited) },
          },
          tx,
        );
      },
    });

    this.logger.info('Платёж подтверждён', {
      payment_id: payment.id,
      client_id: payment.clientId,
    });
    return this.require(paymentId);
  }

  /** Отказ: деньги не пришли или пришли не те. Причина видна клиенту. */
  async reject(paymentId: Id<'payment'>, actor: PaymentActor, reason: string): Promise<PaymentRow> {
    const payment = await this.require(paymentId);
    if (payment.status === 'rejected') return payment;

    const rejected = await this.repository.db.transaction(async (tx) => {
      const resolved = await this.repository.resolve(
        paymentId,
        { status: 'rejected', resolutionNote: reason, resolvedByUserId: actor.userId },
        tx,
      );
      if (resolved === undefined) return undefined;
      await this.audit.record(
        {
          action: 'payment.rejected',
          entityType: 'payment',
          entityId: paymentId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          before: { status: 'pending', amount: Money.format(payment.amount) },
          after: { status: 'rejected', reason },
        },
        tx,
      );
      return resolved;
    });
    if (rejected === undefined) throw conflict('Заявка уже решена: отклонить её нельзя');
    return rejected;
  }

  private async require(id: Id<'payment'>): Promise<PaymentRow> {
    const payment = await this.repository.findById(id);
    if (payment === undefined) throw notFound('Заявка не найдена');
    return payment;
  }

  private providerOf(payment: PaymentRow): PaymentProvider {
    const provider = this.providers.get(payment.provider);
    if (provider === undefined) {
      throw conflict(`Способ пополнения «${payment.provider}» не подключён`);
    }
    return provider;
  }
}
