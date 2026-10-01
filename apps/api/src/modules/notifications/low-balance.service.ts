/**
 * Письмо клиенту, когда на счёте остаётся мало
 * ([ADR-0060](../../../../../docs/adr/0060-pismo-o-nizkom-balanse.md)).
 *
 * Клиент не должен терять трафик из-за забытого пополнения: при нулевой доступной сумме
 * вызовы отклоняются (`insufficient_funds`), и узнаёт он об этом по жалобам своих людей.
 *
 * Догоняющая задача ([ADR-0020](../../../../../docs/adr/0020-fonovye-zadachi.md)): решение
 * принимается по текущему состоянию счёта и по очереди писем, а не по «сделанному с прошлого
 * запуска». Повтор — не чаще `REPEAT_DAYS`, по самой очереди писем: схема базы не меняется.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Money, type Id, type MoneyAmount } from '@zvonix/shared';
import { BillingRepository } from '../billing/billing.repository.js';
import { ReservationService } from '../billing/reservation.service.js';
import { IdentityService } from '../identity/identity.service.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { MailService } from '../mail/mail.service.js';
import { SettingsService } from '../settings/settings.service.js';

/** Вид письма в очереди: по нему же считается, что письмо уже отправляли. */
const LOW_BALANCE_KIND = 'low_balance';

/** Не чаще раза в трое суток: напоминание, а не поток. */
const REPEAT_DAYS = 3;

/** Клиентов за один запрос к базе: проход идёт страницами и доходит до конца. */
const LOW_BALANCE_BATCH = 200;

const DAY_MS = 86_400_000;

interface Candidate {
  readonly id: Id<'client'>;
  readonly name: string;
  readonly ownerUserId: Id<'user'>;
}

@Injectable()
export class LowBalanceService {
  private readonly logger: Logger;

  constructor(
    private readonly billing: BillingRepository,
    private readonly reservations: ReservationService,
    private readonly identity: IdentityService,
    private readonly mail: MailService,
    private readonly settings: SettingsService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('low-balance');
  }

  /** Ставит письма в очередь; возвращает, сколько поставлено. */
  async notify(now: Date = new Date()): Promise<number> {
    const { lowBalanceEnabled, lowBalanceAmount } = await this.settings.notifications();
    if (!lowBalanceEnabled || lowBalanceAmount <= 0) return 0;

    const threshold = Money.fromMajorUnits(String(lowBalanceAmount));
    const since = new Date(now.getTime() - REPEAT_DAYS * DAY_MS);
    let queued = 0;
    let after: Id<'client'> | undefined;

    for (;;) {
      const batch = await this.billing.listActiveClientOwners(after, LOW_BALANCE_BATCH);
      for (const client of batch) {
        if (await this.notifyOne(client, threshold, since)) queued += 1;
      }
      if (batch.length < LOW_BALANCE_BATCH) break;
      after = batch.at(-1)?.id;
    }
    return queued;
  }

  private async notifyOne(
    client: Candidate,
    threshold: MoneyAmount,
    since: Date,
  ): Promise<boolean> {
    try {
      const funds = await this.reservations.available(client.id);
      if (Money.compare(funds.available, threshold) >= 0) return false;

      const owner = await this.identity.findPublicUser(client.ownerUserId);
      // Писать на неподтверждённый адрес нельзя: письмо о деньгах уйдёт постороннему.
      if (owner.emailConfirmedAt === null || owner.status !== 'active') return false;
      if (await this.mail.hasRecent(LOW_BALANCE_KIND, owner.email, since)) return false;

      return await this.mail.enqueue({
        recipient: owner.email,
        kind: LOW_BALANCE_KIND,
        subject: 'Zvonix: на счёте осталось мало',
        body: [
          `На счёте «${client.name}» можно потратить ${Money.format(funds.available)} ₽.`,
          '',
          'Когда эта сумма закончится, вызовы начнут отклоняться. Пополните счёт заранее.',
          '',
          `Это письмо приходит не чаще раза в ${String(REPEAT_DAYS)} дня, пока денег мало.`,
        ].join('\n'),
      });
    } catch (cause) {
      // Один клиент не должен останавливать остальных: ошибка остаётся в журнале.
      this.logger.error('Письмо о низком балансе не поставлено', cause);
      return false;
    }
  }
}
