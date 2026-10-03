/**
 * Письмо партнёру, когда его SIM или шлюз отключились из-за отказов сети
 * ([ADR-0066](../../../../../docs/adr/0066-pisma-o-resheniyah-i-otklyucheniyah.md)).
 *
 * Пока оборудование отключено, оно не зарабатывает, а партнёр узнаёт об этом, только заглянув
 * в кабинет. Отключение по порогу отказов делает автомат ([ADR-0027](../../../../../docs/adr/0027-porog-otklyucheniya.md)):
 * шлюз — со ссылкой на источник (`suspendedBy = failure_threshold`), SIM — состоянием
 * `throttled`. Отключение самим партнёром или администратором письма не вызывает: об этом знает
 * тот, кто отключил.
 *
 * Догоняющая задача (ADR-0020): по текущему состоянию и по очереди писем. Пока объект
 * отключён, напоминание — не чаще раза в трое суток.
 */

import { Inject, Injectable } from '@nestjs/common';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import type { PartnerId } from '../billing/billing.repository.js';
import { BillingService } from '../billing/billing.service.js';
import { IdentityService } from '../identity/identity.service.js';
import { MailService } from '../mail/mail.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { TelephonyService } from '../telephony/telephony.service.js';

const REPEAT_DAYS = 3;
const DAY_MS = 86_400_000;

interface Suspended {
  readonly scope: 'gateway' | 'sim';
  readonly id: string;
  readonly partnerId: PartnerId;
  readonly label: string;
}

@Injectable()
export class SuspensionNoticeService {
  private readonly logger: Logger;

  constructor(
    private readonly telephony: TelephonyService,
    private readonly billing: BillingService,
    private readonly identity: IdentityService,
    private readonly mail: MailService,
    private readonly settings: SettingsService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('suspension-notice');
  }

  /** Ставит письма в очередь; возвращает, сколько поставлено. */
  async notify(now: Date = new Date()): Promise<number> {
    const { partnerSuspensionEnabled } = await this.settings.notifications();
    if (!partnerSuspensionEnabled) return 0;

    const since = new Date(now.getTime() - REPEAT_DAYS * DAY_MS);
    let queued = 0;
    for (const item of await this.suspended()) {
      if (await this.notifyOne(item, since)) queued += 1;
    }
    return queued;
  }

  /** Что сейчас отключено автоматом. Сбой чтения одного источника не гасит другой. */
  private async suspended(): Promise<Suspended[]> {
    const found: Suspended[] = [];
    try {
      for (const gateway of await this.telephony.listGateways()) {
        if (gateway.status === 'suspended' && gateway.suspendedBy === 'failure_threshold') {
          found.push({
            scope: 'gateway',
            id: gateway.id,
            partnerId: gateway.partnerId,
            label: `Шлюз «${gateway.name}»`,
          });
        }
      }
    } catch (cause) {
      this.logger.error('Отключённые шлюзы не прочитаны', cause);
    }
    try {
      for (const sim of await this.telephony.listSims()) {
        if (sim.status === 'throttled') {
          found.push({
            scope: 'sim',
            id: sim.id,
            partnerId: sim.partnerId,
            label: `SIM ${sim.msisdn}`,
          });
        }
      }
    } catch (cause) {
      this.logger.error('Отключённые SIM не прочитаны', cause);
    }
    return found;
  }

  private async notifyOne(item: Suspended, since: Date): Promise<boolean> {
    try {
      const partner = await this.billing.partnerWithBalance(item.partnerId);
      if (partner.status !== 'verified') return false;
      const owner = await this.identity.findPublicUser(partner.ownerUserId);
      if (owner.emailConfirmedAt === null || owner.status !== 'active') return false;

      const kind = `suspended:${item.scope}:${item.id}`;
      if (await this.mail.hasRecent(kind, owner.email, since)) return false;

      return await this.mail.enqueue({
        recipient: owner.email,
        kind,
        subject: `Zvonix: ${item.label} отключ${item.scope === 'sim' ? 'ена' : 'ён'}`,
        body: [
          `${item.label} отключ${item.scope === 'sim' ? 'ена' : 'ён'} автоматически: за последнее время слишком много отказов сети.`,
          '',
          'Пока оборудование отключено, вызовы на него не идут и оно не зарабатывает.',
          'Проверьте SIM, баланс на ней и связь шлюза, затем включите оборудование в кабинете, в разделе «Оборудование».',
          '',
          `Напоминание — не чаще раза в ${String(REPEAT_DAYS)} дня, пока оборудование отключено.`,
        ].join('\n'),
      });
    } catch (cause) {
      this.logger.error('Письмо об отключении не поставлено', cause, { scope: item.scope });
      return false;
    }
  }
}
