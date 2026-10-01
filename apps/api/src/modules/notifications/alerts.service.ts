/**
 * Тревоги администраторам по почте
 * ([ADR-0062](../../../../../docs/adr/0062-trevogi-administratoram.md)).
 *
 * Площадка ничего не скажет сама, пока на неё не посмотрят: узел замолчал ночью, SIM
 * перестала соединять — и об этом узнают по жалобам клиентов. Здесь два условия, оба по
 * текущему состоянию, а не по событию (ADR-0020: пропущенный проход ничего не теряет):
 * узел не на связи и объект, у которого почти не состоятся вызовы.
 *
 * Повтор по одному и тому же объекту — не чаще `REPEAT_HOURS`, и считается по самой очереди
 * писем: схема базы не меняется (как у письма о низком балансе, ADR-0060).
 */

import { Inject, Injectable } from '@nestjs/common';
import type { PublicUser } from '../identity/identity.service.js';
import { IdentityService } from '../identity/identity.service.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { MailService } from '../mail/mail.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { QualityService, type QualityView } from '../telephony/quality.service.js';

/** Не чаще раза в полсуток по одному объекту: напоминание, а не поток. */
const REPEAT_HOURS = 12;

/** Окно качества — час: за него успевает набраться картина, но не успевает остыть. */
const QUALITY_WINDOW_MINUTES = 60;

/** Меньше вызовов — доля ни о чём не говорит (тот же порог, что «мало вызовов» на экране «Качество»). */
const ENOUGH_CALLS = 10;

/** Ниже этой доли состоявшихся, в десятитысячных, объект считается больным (30 %). */
const LOW_ASR_BASIS_POINTS = 3000;

/** Администраторов на площадке единицы; страница с запасом покрывает всех. */
const ADMINS_PAGE = 100;

const HOUR_MS = 3_600_000;

interface Alert {
  /** Вид письма в очереди: объект входит в него, поэтому повтор считается по каждому объекту. */
  readonly kind: string;
  readonly subject: string;
  readonly body: string;
}

@Injectable()
export class AlertsService {
  private readonly logger: Logger;

  constructor(
    private readonly identity: IdentityService,
    private readonly mail: MailService,
    private readonly settings: SettingsService,
    private readonly nodes: NodesService,
    private readonly quality: QualityService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('alerts');
  }

  /** Ставит письма в очередь; возвращает, сколько поставлено. */
  async notify(now: Date = new Date()): Promise<number> {
    const { alertsEnabled } = await this.settings.notifications();
    if (!alertsEnabled) return 0;

    const recipients = await this.recipients();
    if (recipients.length === 0) return 0;

    const alerts = await this.collect(now);
    if (alerts.length === 0) return 0;

    const since = new Date(now.getTime() - REPEAT_HOURS * HOUR_MS);
    let queued = 0;
    for (const alert of alerts) {
      for (const admin of recipients) {
        if (await this.send(admin, alert, since)) queued += 1;
      }
    }
    return queued;
  }

  /** Администраторы, которым письмо можно слать: работающие и с подтверждённой почтой. */
  private async recipients(): Promise<PublicUser[]> {
    const { users } = await this.identity.listUsers({
      role: 'admin',
      status: 'active',
      limit: ADMINS_PAGE,
      offset: 0,
    });
    return users.filter((user) => user.emailConfirmedAt !== null);
  }

  /**
   * Что сейчас неблагополучно. Сбой одного источника не гасит другой: тревога о качестве
   * нужна как раз тогда, когда что-то уже сломано.
   */
  private async collect(now: Date): Promise<Alert[]> {
    const alerts: Alert[] = [];

    try {
      for (const node of await this.nodes.list()) {
        if (node.status !== 'offline') continue;
        const since =
          node.lastHeartbeatAt === null
            ? 'связи с ним ещё не было'
            : `последний сигнал: ${node.lastHeartbeatAt.toISOString()}`;
        alerts.push({
          kind: `alert_node:${node.id}`,
          subject: `Zvonix: узел «${node.name}» не на связи`,
          body: [
            `Узел «${node.name}» не отвечает (${since}).`,
            '',
            'Пока он молчит, вызовы на него не направляются, а SIM и шлюзы на нём не работают.',
            'Проверьте машину и службу агента.',
          ].join('\n'),
        });
      }
    } catch (cause) {
      this.logger.error('Тревоги: узлы не прочитаны', cause);
    }

    try {
      const since = new Date(now.getTime() - QUALITY_WINDOW_MINUTES * 60_000);
      for (const row of await this.quality.sims(since)) {
        if (isSick(row)) alerts.push(qualityAlert('sim', 'SIM', row));
      }
      for (const row of await this.quality.gateways(since)) {
        if (isSick(row)) alerts.push(qualityAlert('gateway', 'Шлюз', row));
      }
    } catch (cause) {
      this.logger.error('Тревоги: качество не прочитано', cause);
    }

    return alerts;
  }

  private async send(admin: PublicUser, alert: Alert, since: Date): Promise<boolean> {
    try {
      if (await this.mail.hasRecent(alert.kind, admin.email, since)) return false;
      return await this.mail.enqueue({
        recipient: admin.email,
        kind: alert.kind,
        subject: alert.subject,
        body: `${alert.body}\n\nПовтор по этому объекту — не чаще раза в ${String(REPEAT_HOURS)} часов, пока неполадка остаётся.`,
      });
    } catch (cause) {
      // Один адрес не должен останавливать остальные письма: ошибка остаётся в журнале.
      this.logger.error('Тревога не поставлена', cause, { kind: alert.kind });
      return false;
    }
  }
}

/** Работает, вызовов достаточно, а состоявшихся почти нет. Отключённый объект не тревожит: он уже снят. */
const isSick = (row: QualityView): boolean =>
  row.subjectStatus === 'active' &&
  row.attempts >= ENOUGH_CALLS &&
  row.asrBasisPoints < LOW_ASR_BASIS_POINTS;

function qualityAlert(scope: 'sim' | 'gateway', label: string, row: QualityView): Alert {
  const percent = (row.asrBasisPoints / 100).toFixed(1).replace('.', ',');
  return {
    kind: `alert_quality:${scope}:${row.subjectId}`,
    subject: `Zvonix: ${label} ${row.subjectName} почти не соединяет`,
    body: [
      `${label} ${row.subjectName} (партнёр «${row.partnerName}») за последний час: вызовов ${String(row.attempts)}, состоялось ${String(row.answered)} (${percent} %).`,
      '',
      `Отказов сети: ${String(row.networkFailures)}. Посмотрите раздел «Качество» и, если это неисправность, отключите объект.`,
    ].join('\n'),
  };
}
