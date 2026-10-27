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
import { Money } from '@zvonix/shared';
import type { PublicUser } from '../identity/identity.service.js';
import { IdentityService } from '../identity/identity.service.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import type { ClientId } from '../billing/billing.repository.js';
import { BillingService } from '../billing/billing.service.js';
import { MailService } from '../mail/mail.service.js';
import { MessagesService } from '../messaging/messages.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { ServersService } from '../servers/servers.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { ShortAnswerRow } from '../telephony/quality.repository.js';
import { QualityService, type QualityView } from '../telephony/quality.service.js';
import { CertificateStatusService } from '../updates/certificate-status.service.js';
import { GithubTokenStatusService } from '../updates/github-token-status.service.js';

/** Не чаще раза в полсуток по одному объекту: напоминание, а не поток. */
const REPEAT_HOURS = 12;

/** Окно качества — час: за него успевает набраться картина, но не успевает остыть. */
const QUALITY_WINDOW_MINUTES = 60;

/** Меньше вызовов — доля ни о чём не говорит (тот же порог, что «мало вызовов» на экране «Качество»). */
const ENOUGH_CALLS = 10;

/** Ниже этой доли состоявшихся, в десятитысячных, объект считается больным (30 %). */
const LOW_ASR_BASIS_POINTS = 3000;

/** Минут перегрузки процессора, о которых пишем (окно — в `ServersService`). */
const OVERLOAD_MINUTES = 10;

/** Сообщений за час, меньше которых доля неудач ни о чём не говорит. */
const MESSAGES_ENOUGH = 10;

/** Администраторов на площадке единицы; страница с запасом покрывает всех. */
const ADMINS_PAGE = 100;

const HOUR_MS = 3_600_000;

/**
 * Заявка на пополнение ждёт решения дольше этого — пора напомнить. Не мгновенно: человек,
 * который сам в кабинете, увидит её и так, а письмо нужно тому, кто туда не смотрит.
 */
const PAYMENT_WAIT_MINUTES = 5;

/** Заявок в одном письме-проходе — с запасом: открытых на клиента не больше пяти. */
const PAYMENTS_PAGE = 100;

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
    private readonly payments: PaymentsService,
    private readonly billing: BillingService,
    private readonly servers: ServersService,
    private readonly messages: MessagesService,
    private readonly certificate: CertificateStatusService,
    private readonly githubToken: GithubTokenStatusService,
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

    try {
      const since = new Date(now.getTime() - QUALITY_WINDOW_MINUTES * 60_000);
      for (const row of await this.quality.shortAnswerTrunks(since)) {
        alerts.push(shortAnswerAlert(row));
      }
    } catch (cause) {
      this.logger.error('Тревоги: короткие ответы транков не прочитаны', cause);
    }

    try {
      alerts.push(...(await this.paymentAlerts(now)));
    } catch (cause) {
      this.logger.error('Тревоги: заявки на пополнение не прочитаны', cause);
    }

    try {
      for (const disk of await this.servers.lowDisk(now)) {
        const percent = Math.round((disk.freeMb / disk.totalMb) * 100);
        alerts.push({
          kind: `alert_disk:${disk.id ?? 'platform'}`,
          subject: `Zvonix: на диске «${disk.name}» мало места`,
          body: [
            `На диске «${disk.name}» свободно ${String(percent)} % (${String(Math.round(disk.freeMb / 1024))} из ${String(Math.round(disk.totalMb / 1024))} ГБ).`,
            '',
            'Когда место кончится, записи разговоров перестанут сохраняться, а сервер может остановиться.',
            'Очистите ненужное или уменьшите срок хранения записей в «Настройки площадки» → «Хранение».',
          ].join('\n'),
        });
      }
    } catch (cause) {
      this.logger.error('Тревоги: диски не прочитаны', cause);
    }

    try {
      for (const server of await this.servers.strained(now)) {
        const id = server.id ?? 'platform';
        if (server.memoryUsedPercent !== undefined) {
          alerts.push({
            kind: `alert_memory:${id}`,
            subject: `Zvonix: на «${server.name}» почти не осталось памяти`,
            body: [
              `На «${server.name}» занято ${String(server.memoryUsedPercent)} % памяти.`,
              '',
              'Когда память кончится, система начнёт останавливать процессы — звонки и кабинет могут пропасть.',
              'Посмотрите страницу «Серверы» (история) и перезапустите то, что разрослось, либо добавьте памяти.',
            ].join('\n'),
          });
        }
        if (server.loadPerCore !== undefined) {
          alerts.push({
            kind: `alert_cpu:${id}`,
            subject: `Zvonix: процессор «${server.name}» перегружен`,
            body: [
              `Нагрузка на «${server.name}» держится выше нормы последние ${String(OVERLOAD_MINUTES)} минут: ${server.loadPerCore.toFixed(1).replace('.', ',')} на каждое ядро.`,
              '',
              'Звонки на перегруженном сервере рвутся и звучат с провалами. Посмотрите страницу «Серверы» и разгрузите машину.',
            ].join('\n'),
          });
        }
      }
    } catch (cause) {
      this.logger.error('Тревоги: нагрузка серверов не прочитана', cause);
    }

    try {
      alerts.push(...(await this.messageAlerts(now)));
    } catch (cause) {
      this.logger.error('Тревоги: сообщения не прочитаны', cause);
    }

    try {
      alerts.push(...(await this.restrictedAccountAlerts(now)));
    } catch (cause) {
      this.logger.error('Тревоги: ограничения аккаунтов MAX не прочитаны', cause);
    }

    try {
      alerts.push(...(await this.certificateAlerts(now)));
    } catch (cause) {
      this.logger.error('Тревоги: сертификат не прочитан', cause);
    }

    try {
      alerts.push(...(await this.githubTokenAlerts(now)));
    } catch (cause) {
      this.logger.error('Тревоги: токен GitHub не прочитан', cause);
    }

    return alerts;
  }

  /**
   * Сертификат кабинета скоро истечёт, истёк или не выпущен (ADR-0083). При работающем
   * автопродлении письма не будет вовсе: оно нужно, когда продление тихо сломалось.
   */
  private async certificateAlerts(now: Date): Promise<Alert[]> {
    const status = await this.certificate.status(now);
    const name = status.domain ?? 'кабинета';
    const hint = [
      '',
      'Откройте «Настройки площадки» → «Сертификат»: там видно причину и кнопка «Выпустить сертификат».',
      'Если выпуск не получается, пришлите журнал из того же раздела.',
    ];
    switch (status.state) {
      case 'soon':
        return [
          {
            kind: 'alert_certificate:soon',
            subject: `Zvonix: сертификат ${name} скоро истекает`,
            body: [
              `Сертификат ${name} действует ещё ${String(status.days_left ?? 0)} дн. (до ${status.not_after ?? 'неизвестно'}).`,
              status.auto_renew === true
                ? 'Автопродление включено, но не сработало: проверьте, что домен указывает на этот сервер и порт 80 открыт.'
                : 'Автопродление выключено: сертификат сам не продлится.',
              'После окончания браузеры начнут предупреждать посетителей и клиентов.',
              ...hint,
            ].join('\n'),
          },
        ];
      case 'expired':
        return [
          {
            kind: 'alert_certificate:expired',
            subject: `Zvonix: сертификат ${name} истёк`,
            body: [
              `Срок сертификата ${name} истёк (${status.not_after ?? 'неизвестно'}). Браузеры предупреждают всех, кто открывает кабинет и сайт.`,
              ...hint,
            ].join('\n'),
          },
        ];
      case 'missing':
        return [
          {
            kind: 'alert_certificate:missing',
            subject: `Zvonix: для ${name} нет сертификата`,
            body: [
              `На сервере нет сертификата для ${name}: соединение с кабинетом не защищено.`,
              ...hint,
            ].join('\n'),
          },
        ];
      default:
        return [];
    }
  }

  /**
   * Токен GitHub для обновлений скоро кончится или перестал приниматься (ADR-0084). Без него обновления
   * из кабинета встанут молча, поэтому предупреждаем заранее.
   */
  private async githubTokenAlerts(now: Date): Promise<Alert[]> {
    const status = await this.githubToken.status(now);
    const hint =
      'Выпустите новый токен в GitHub и впишите его в «Настройки площадки» → «Обновления».';
    if (status.state === 'soon') {
      return [
        {
          kind: 'alert_github_token:soon',
          subject: 'Zvonix: токен GitHub для обновлений скоро кончится',
          body: [
            `Токен, которым площадка скачивает выпуски, действует ещё ${String(status.days_left ?? 0)} дн. (до ${status.expires_at ?? 'неизвестно'}).`,
            'После этого обновления из кабинета перестанут работать.',
            '',
            hint,
          ].join('\n'),
        },
      ];
    }
    if (status.state === 'invalid') {
      return [
        {
          kind: 'alert_github_token:invalid',
          subject: 'Zvonix: токен GitHub для обновлений не принимается',
          body: [
            `Площадка не может скачивать выпуски: ${status.problem ?? 'токен не принят'}.`,
            'Обновления из кабинета не работают, пока токен не заменён.',
            '',
            hint,
          ].join('\n'),
        },
      ];
    }
    return [];
  }

  /** Сообщения MAX, которые массово не уходят: за последний час не отправлено больше половины. */
  private async messageAlerts(now: Date): Promise<Alert[]> {
    const health = await this.messages.health(new Date(now.getTime() - HOUR_MS));
    if (health.total < MESSAGES_ENOUGH || health.failed * 2 < health.total) return [];
    return [
      {
        kind: 'alert_messages',
        subject: 'Zvonix: сообщения MAX массово не отправляются',
        body: [
          `За последний час принято ${String(health.total)} сообщений, не отправлено ${String(health.failed)}.`,
          '',
          'Скорее всего, аккаунты MAX партнёров вышли из мессенджера или у провайдера сбой. Проверьте раздел «Сообщения MAX»: состояние аккаунтов и последние сообщения. Деньги за неотправленное клиентам возвращены.',
        ].join('\n'),
      },
    ];
  }

  /**
   * У партнёра за час «Ограничен» или «Заблокирован» стали два аккаунта MAX и больше (ADR-0078, ревизия 2026-10-23): владелец
   * узнавал об этом от такси, а не от площадки.
   */
  private async restrictedAccountAlerts(now: Date): Promise<Alert[]> {
    const bursts = await this.messages.restrictedBursts(new Date(now.getTime() - HOUR_MS));
    return bursts.map((burst) => ({
      kind: `alert_accounts_restricted:${burst.partnerId}`,
      subject: `Zvonix: у партнёра ${burst.partnerName} ограничены сразу ${String(burst.accounts)} аккаунта MAX`,
      body: [
        `За последний час у партнёра ${burst.partnerName} MAX ограничил или заблокировал ${String(burst.accounts)} аккаунта.`,
        '',
        'Ограниченный аккаунт не может писать тем, у кого он не в контактах, — площадка не отдаёт ему сообщения, пока MAX не снимет ограничение. Сразу несколько — признак, что аккаунты связаны (один телефон, одна сеть) или поток для них слишком большой. Не переподключайте их; проверьте раздел «Сообщения MAX».',
      ].join('\n'),
    }));
  }

  /** Заявки на пополнение, которые ждут решения администратора дольше `PAYMENT_WAIT_MINUTES`. */
  private async paymentAlerts(now: Date): Promise<Alert[]> {
    const border = now.getTime() - PAYMENT_WAIT_MINUTES * 60_000;
    const { rows } = await this.payments.list({
      status: 'pending',
      limit: PAYMENTS_PAGE,
      offset: 0,
    });

    const alerts: Alert[] = [];
    for (const payment of rows) {
      if (payment.createdAt.getTime() > border) continue;
      const name = await this.clientName(payment.clientId);
      const amount = Money.format(payment.amount);
      alerts.push({
        kind: `alert_payment:${payment.id}`,
        subject: `Zvonix: заявка на пополнение ${amount} ₽ ждёт решения`,
        body: [
          `Клиент ${name} просит пополнить счёт на ${amount} ₽ и ждёт решения.`,
          ...(payment.comment === null ? [] : [`Комментарий клиента: ${payment.comment}`]),
          '',
          'Сверьте поступление и подтвердите или отклоните заявку в разделе «Платежи».',
        ].join('\n'),
      });
    }
    return alerts;
  }

  /** Имя клиента для письма; не нашлось — письмо всё равно уходит. */
  private async clientName(clientId: ClientId): Promise<string> {
    try {
      const client = await this.billing.clientWithBalance(clientId);
      return `«${client.name}»`;
    } catch {
      return 'без названия';
    }
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

/**
 * Транк похож на ложный ответ (ADR-0100, п. 6): провайдер «снимает трубку» сам, чтобы взять плату за вызов. Это решение
 * о партнёре, а не поломка, — поэтому письмо, а не автомат.
 */
function shortAnswerAlert(row: ShortAnswerRow): Alert {
  return {
    kind: `alert_short_answer:${row.gatewayId}`,
    subject: `Zvonix: SIP-провайдер ${row.gatewayName} — подозрительно короткие разговоры`,
    body: [
      `SIP-провайдер ${row.gatewayName} (партнёр «${row.partnerName}») за последний час: отвечено ${String(row.answered)}, из них короче 3 секунд — ${String(row.short)}.`,
      '',
      'Так выглядит ложный ответ: провайдер сам «снимает трубку», и клиент платит за звонок, которого не было. Площадка его не отключала — честные короткие звонки у такси тоже бывают.',
      'Посмотрите записи разговоров в «Звонки» и, если это обман, отключите провайдера в карточке партнёра.',
    ].join('\n'),
  };
}

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
