/**
 * Письма партнёру о его оборудовании: SIM или шлюз отключились из-за отказов сети
 * ([ADR-0066](../../../../../docs/adr/0066-pisma-o-resheniyah-i-otklyucheniyah.md)) или почти не соединяют
 * по вине сети ([ADR-0103](../../../../../docs/adr/0103-shlyuz-na-svyazi-po-oprosu-i-trevoga-partnyoru.md), п. 5).
 *
 * Пока оборудование отключено или срывает вызовы, оно не зарабатывает, а партнёр узнаёт об этом, только заглянув
 * в кабинет. Исправить причину — баланс SIM, блокировку, сигнал, зависший шлюз — может только он.
 *
 * Отключение по порогу отказов делает автомат ([ADR-0027](../../../../../docs/adr/0027-porog-otklyucheniya.md)):
 * шлюз — со ссылкой на источник (`suspendedBy = failure_threshold`), SIM — состоянием `throttled`. Отключение самим
 * партнёром или администратором письма не вызывает: об этом знает тот, кто отключил. «Почти не соединяет» — только
 * когда несостоявшиеся в основном отказы сети: «не ответил» и «занято» говорят о базе клиента, а не о карте.
 *
 * Догоняющая задача (ADR-0020): по текущему состоянию и по очереди писем. Напоминание об отключении — не чаще раза
 * в трое суток, о плохом соединении — раза в 12 часов по объекту.
 */

import { Inject, Injectable } from '@nestjs/common';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import type { PartnerId } from '../billing/billing.repository.js';
import { BillingService } from '../billing/billing.service.js';
import { IdentityService } from '../identity/identity.service.js';
import { MailService } from '../mail/mail.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { failsOnNetwork, QualityService } from '../telephony/quality.service.js';
import { TelephonyService } from '../telephony/telephony.service.js';

const HOUR_MS = 3_600_000;
const SUSPENDED_REPEAT_HOURS = 72;
const POOR_REPEAT_HOURS = 12;

interface Notice {
  readonly kind: string;
  readonly partnerId: PartnerId;
  readonly subject: string;
  readonly body: string;
  readonly repeatHours: number;
}

@Injectable()
export class EquipmentNoticeService {
  private readonly logger: Logger;

  constructor(
    private readonly telephony: TelephonyService,
    private readonly quality: QualityService,
    private readonly billing: BillingService,
    private readonly identity: IdentityService,
    private readonly mail: MailService,
    private readonly settings: SettingsService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('equipment-notice');
  }

  /** Ставит письма в очередь; возвращает, сколько поставлено. */
  async notify(now: Date = new Date()): Promise<number> {
    const { partnerSuspensionEnabled } = await this.settings.notifications();
    if (!partnerSuspensionEnabled) return 0;

    let queued = 0;
    for (const notice of [...(await this.suspended()), ...(await this.poorlyConnecting(now))]) {
      if (await this.notifyOne(notice, now)) queued += 1;
    }
    return queued;
  }

  /** Что сейчас отключено автоматом. Сбой чтения одного источника не гасит другой. */
  private async suspended(): Promise<Notice[]> {
    const found: Notice[] = [];
    try {
      for (const gateway of await this.telephony.listGateways()) {
        if (gateway.status === 'suspended' && gateway.suspendedBy === 'failure_threshold') {
          found.push(
            suspendedNotice('gateway', gateway.id, gateway.partnerId, `Шлюз «${gateway.name}»`),
          );
        }
      }
    } catch (cause) {
      this.logger.error('Отключённые шлюзы не прочитаны', cause);
    }
    try {
      for (const sim of await this.telephony.listSims()) {
        if (sim.status === 'throttled') {
          found.push(suspendedNotice('sim', sim.id, sim.partnerId, `SIM ${sim.msisdn}`));
        }
      }
    } catch (cause) {
      this.logger.error('Отключённые SIM не прочитаны', cause);
    }
    return found;
  }

  /** Что почти не соединяет из-за отказов сети за последний час. */
  private async poorlyConnecting(now: Date): Promise<Notice[]> {
    try {
      const { sims, gateways } = await this.quality.poorlyConnecting(now);
      return [
        ...sims
          .filter(failsOnNetwork)
          .map((row) => ({ scope: 'sim' as const, label: `SIM ${row.subjectName}`, row })),
        ...gateways
          .filter(failsOnNetwork)
          .map((row) => ({ scope: 'gateway' as const, label: `Шлюз «${row.subjectName}»`, row })),
      ].map(({ scope, label, row }) => ({
        kind: `poor_connection:${scope}:${row.subjectId}`,
        partnerId: row.partnerId,
        subject: `Zvonix: ${label} почти не соединяет`,
        body: [
          `${label} за последний час: вызовов ${String(row.attempts)}, состоялось ${String(row.answered)}, сорвались в сети — ${String(row.networkFailures)}.`,
          '',
          'Вызов срывается в сети, когда не доходит до абонента: на SIM кончились деньги, её заблокировали, слабый сигнал или завис шлюз.',
          'Проверьте баланс и SIM, сигнал и сам шлюз. Пока вызовы срываются, оборудование не зарабатывает, а при частых отказах площадка отключит его автоматически.',
          '',
          `Напоминание — не чаще раза в ${String(POOR_REPEAT_HOURS)} часов, пока неполадка остаётся.`,
        ].join('\n'),
        repeatHours: POOR_REPEAT_HOURS,
      }));
    } catch (cause) {
      this.logger.error('Качество оборудования не прочитано', cause);
      return [];
    }
  }

  private async notifyOne(notice: Notice, now: Date): Promise<boolean> {
    try {
      const partner = await this.billing.partnerWithBalance(notice.partnerId);
      if (partner.status !== 'verified') return false;
      const owner = await this.identity.findPublicUser(partner.ownerUserId);
      if (owner.emailConfirmedAt === null || owner.status !== 'active') return false;

      const since = new Date(now.getTime() - notice.repeatHours * HOUR_MS);
      if (await this.mail.hasRecent(notice.kind, owner.email, since)) return false;

      return await this.mail.enqueue({
        recipient: owner.email,
        kind: notice.kind,
        subject: notice.subject,
        body: notice.body,
      });
    } catch (cause) {
      this.logger.error('Письмо партнёру об оборудовании не поставлено', cause, {
        kind: notice.kind,
      });
      return false;
    }
  }
}

function suspendedNotice(
  scope: 'gateway' | 'sim',
  id: string,
  partnerId: PartnerId,
  label: string,
): Notice {
  const ending = scope === 'sim' ? 'ена' : 'ён';
  return {
    kind: `suspended:${scope}:${id}`,
    partnerId,
    subject: `Zvonix: ${label} отключ${ending}`,
    body: [
      `${label} отключ${ending} автоматически: за последнее время слишком много отказов сети.`,
      '',
      'Пока оборудование отключено, вызовы на него не идут и оно не зарабатывает.',
      'Проверьте SIM, баланс на ней и связь шлюза, затем включите оборудование в кабинете, в разделе «Оборудование».',
      '',
      `Напоминание — не чаще раза в ${String(SUSPENDED_REPEAT_HOURS / 24)} дня, пока оборудование отключено.`,
    ].join('\n'),
    repeatHours: SUSPENDED_REPEAT_HOURS,
  };
}
