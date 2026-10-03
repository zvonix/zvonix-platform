/**
 * Письмо клиенту о решении по его заявке на пополнение
 * ([ADR-0066](../../../../../docs/adr/0066-pisma-o-resheniyah-i-otklyucheniyah.md)).
 *
 * Клиент перевёл деньги и ждёт: без письма он узнаёт о зачислении или отказе, только заглянув
 * в кабинет. Отзыв заявки самим клиентом письма не вызывает — он и так знает.
 *
 * Догоняющая задача ([ADR-0020](../../../../../docs/adr/0020-fonovye-zadachi.md)): отбирает
 * решённые за последние сутки и сверяется с очередью писем (`kind` с номером заявки), а не с
 * «сделанным с прошлого запуска» — пропущенный проход ничего не теряет, повтор не возникает.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Money } from '@zvonix/shared';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { BillingService } from '../billing/billing.service.js';
import { IdentityService } from '../identity/identity.service.js';
import { MailService } from '../mail/mail.service.js';
import type { PaymentRow } from '../payments/payments.repository.js';
import { PaymentsService } from '../payments/payments.service.js';
import { SettingsService } from '../settings/settings.service.js';

/** Решённые за какой срок ещё подлежат письму: сутки с запасом на простой воркера. */
const LOOKBACK_MS = 86_400_000;

/** Заявок за один проход — с запасом: решает их человек, десятки в сутки. */
const BATCH = 200;

/** Срок, в который письмо о той же заявке не повторяется. */
const DEDUP_MS = 30 * 86_400_000;

@Injectable()
export class PaymentNoticeService {
  private readonly logger: Logger;

  constructor(
    private readonly payments: PaymentsService,
    private readonly billing: BillingService,
    private readonly identity: IdentityService,
    private readonly mail: MailService,
    private readonly settings: SettingsService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('payment-notice');
  }

  /** Ставит письма в очередь; возвращает, сколько поставлено. */
  async notify(now: Date = new Date()): Promise<number> {
    const { paymentDecisionEnabled } = await this.settings.notifications();
    if (!paymentDecisionEnabled) return 0;

    const resolved = await this.payments.resolvedSince(
      new Date(now.getTime() - LOOKBACK_MS),
      BATCH,
    );
    let queued = 0;
    for (const payment of resolved) {
      if (await this.notifyOne(payment, new Date(now.getTime() - DEDUP_MS))) queued += 1;
    }
    return queued;
  }

  private async notifyOne(payment: PaymentRow, since: Date): Promise<boolean> {
    try {
      const client = await this.billing.clientWithBalance(payment.clientId);
      const owner = await this.identity.findPublicUser(client.ownerUserId);
      // Письмо о деньгах не уходит на неподтверждённый адрес: оно достанется постороннему.
      if (owner.emailConfirmedAt === null || owner.status !== 'active') return false;

      const kind = `payment_resolved:${payment.id}`;
      if (await this.mail.hasRecent(kind, owner.email, since)) return false;

      const asked = Money.format(payment.amount);
      const accepted = payment.status === 'succeeded' && payment.receivedAmount !== null;
      return await this.mail.enqueue({
        recipient: owner.email,
        kind,
        subject: accepted
          ? 'Zvonix: заявка на пополнение подтверждена'
          : 'Zvonix: заявка на пополнение отклонена',
        body: (accepted
          ? [
              `Заявка на пополнение счёта «${client.name}» на ${asked} ₽ подтверждена.`,
              `На счёт зачислено ${Money.format(payment.receivedAmount ?? payment.amount)} ₽ — деньги уже доступны для звонков.`,
            ]
          : [
              `Заявка на пополнение счёта «${client.name}» на ${asked} ₽ отклонена.`,
              `Причина: ${payment.resolutionNote ?? 'не указана'}.`,
              'Если вы уже перевели деньги, ответьте на это письмо или напишите в поддержку.',
            ]
        ).join('\n'),
      });
    } catch (cause) {
      // Одна заявка не должна останавливать остальные: ошибка остаётся в журнале.
      this.logger.error('Письмо о решении по заявке не поставлено', cause, {
        payment_id: payment.id,
      });
      return false;
    }
  }
}
