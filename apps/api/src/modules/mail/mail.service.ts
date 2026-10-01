/**
 * Почта: очередь в базе, отправка воркером
 * ([ADR-0029](../../../../../docs/adr/0029-pochta.md)).
 *
 * Письмо кладётся в базу **той же транзакцией**, что и породившее его событие,
 * а уходит фоновым проходом. Отправка из обработчика ставила бы время ответа
 * в зависимость от чужого сервера и теряла бы письмо при сбое.
 */

import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { validationFailed } from '@zvonix/shared';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { SettingsService, type MailSettings } from '../settings/settings.service.js';
import { MailRepository, type Executor, type OutboxMessageRow } from './mail.repository.js';

/** Сколько писем берётся за один проход. */
const BATCH_LIMIT = 50;

/** После стольких неудач письмо перестаёт пытаться уйти и помечается неотправленным. */
const MAX_ATTEMPTS = 6;

/** Пауза перед первой повторной попыткой. Дальше удваивается. */
const RETRY_BASE_MS = 60_000;

/** Сколько дней хранятся отправленные письма: в теле лежит одноразовый токен. */
const SENT_RETENTION_DAYS = 14;

/**
 * Сколько писем принимается на один адрес получателя за окно
 * ([ADR-0030](../../../../../docs/adr/0030-predel-pisem-na-adres.md)).
 *
 * Ограничение частоты по адресу источника от заваливания **одного** ящика не спасает:
 * у того, кто это делает, адресов источника столько, сколько узлов в его ботнете,
 * а цель одна. Платит за это не он: жалобы на письма от нашего имени сжигают репутацию
 * отправителя, и перестают доходить письма настоящим людям.
 *
 * Десять в час — с большим запасом для человека, который зарегистрировался, подтвердил
 * адрес, забыл пароль и попросил письмо заново.
 */
const RECIPIENT_LIMIT = 10;
const RECIPIENT_WINDOW_MS = 3_600_000;

/**
 * Пределы соединения с почтовым сервером, мс.
 *
 * Умолчания nodemailer — две минуты на соединение и десять минут тишины в сокете,
 * а у каждого внешнего вызова обязан быть свой предел ([ADR-0003](../../../../../docs/adr/0003-obrabotka-oshibok.md)).
 * Воркер отправляет письмо внутри транзакции, и база закрывает простаивающую транзакцию
 * через 30 с: письмо успевало уйти, отметка об отправке — нет, и оно уходило снова.
 * Пробное письмо кабинет ждёт 40 с.
 *
 * Каждый шаг ограничен отдельно, и зависание на любом из них обрывается не позже чем
 * через 15 с. Сервер, отвечающий на каждом шаге чуть быстрее предела, сумму
 * не ограничивает — это закроет только отправка вне транзакции (TASKS.md).
 */
const SMTP_TIMEOUTS = {
  dnsTimeout: 5_000,
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
} as const;

@Injectable()
export class MailService implements OnApplicationShutdown {
  private readonly logger: Logger;
  /**
   * Соединение и отпечаток настроек, из которых оно собрано.
   *
   * Настройки меняются в админке ([ADR-0031](../../../../../docs/adr/0031-nastroyki-ploshchadki.md)),
   * и соединение, собранное из прежних, продолжало бы ходить на старый сервер со старым
   * паролем. Отпечаток нужен, чтобы это заметить и пересобрать.
   */
  private connected: { transport: Transporter; signature: string } | undefined;

  constructor(
    private readonly repository: MailRepository,
    private readonly settings: SettingsService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('mail');
  }

  /** Настроена ли почта. Узел не задан — письма копятся, но не уходят (ADR-0029). */
  async isConfigured(): Promise<boolean> {
    return (await this.settings.mail()).host !== '';
  }

  /**
   * Кладёт письмо в очередь. `false` — предел писем на адрес исчерпан, письмо не принято.
   *
   * `executor` передаётся тем, кто пишет письмо вместе с событием.
   *
   * Предел проверяется **здесь**, а не у вызывающего: письмо в очередь кладут несколько
   * путей, и путь, добавленный завтра, обязан подчиняться правилу, не зная о нём
   * ([ADR-0030](../../../../../docs/adr/0030-predel-pisem-na-adres.md)).
   */
  async enqueue(
    message: { recipient: string; subject: string; body: string; kind: string },
    executor?: Executor,
  ): Promise<boolean> {
    const quota = await this.canSendTo(message.recipient, new Date(), executor);
    if (!quota.allowed) {
      // Не исключение: два пути отправки обязаны отвечать одинаково независимо ни от чего
      // (ADR-0029), и разница в ответе вернула бы перечисление адресов. След остаётся здесь.
      this.logger.warn('Предел писем на адрес исчерпан: письмо не поставлено в очередь', {
        kind: message.kind,
        recipient: maskEmail(message.recipient),
        limit: RECIPIENT_LIMIT,
        retry_after_seconds: quota.retryAfterSeconds,
      });
      return false;
    }

    // Тело письма в лог не попадает: в нём одноразовый токен, а лог живёт дольше письма.
    await this.repository.enqueue(message, executor);
    this.logger.info('Письмо поставлено в очередь', {
      kind: message.kind,
      recipient: maskEmail(message.recipient),
    });
    return true;
  }

  /**
   * Не повторять письмо одного вида раньше срока: тот, кто шлёт по условию («мало денег»),
   * спрашивает здесь, не отправлял ли уже. Опирается на саму очередь, а не на отдельную
   * отметку: схема базы не меняется, а срок хранения отправленных (14 суток) больше любого
   * разумного интервала повтора.
   */
  async hasRecent(kind: string, recipient: string, since: Date): Promise<boolean> {
    return this.repository.hasRecentOfKind(kind, recipient, since);
  }

  /**
   * Есть ли ещё место на этот адрес.
   *
   * Открыто тем, кто заводит **одноразовый токен вместе с письмом**: спросить надо
   * до записи токена, иначе заявка, чьё письмо всё равно не уйдёт, погасит действующую
   * ссылку человека — и заваливание ящика заодно лишит его возможности восстановить
   * пароль ([ADR-0030](../../../../../docs/adr/0030-predel-pisem-na-adres.md)).
   */
  async canSendTo(
    recipient: string,
    now: Date,
    executor?: Executor,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const since = new Date(now.getTime() - RECIPIENT_WINDOW_MS);
    const recent = await this.repository.countRecent(recipient, since, executor);
    return { allowed: recent.count < RECIPIENT_LIMIT, retryAfterSeconds: recent.retryAfterSeconds };
  }

  /**
   * Отправляет то, чему пора уходить.
   *
   * Проход догоняющий: письма отбираются **по сроку**, а не «появившиеся с прошлого
   * запуска» ([ADR-0020](../../../../../docs/adr/0020-fonovye-zadachi.md)). Пропущенный
   * тик ничего не теряет.
   */
  async deliverDue(now: Date = new Date()): Promise<number> {
    const mail = await this.settings.mail();
    if (mail.host === '') {
      const pending = await this.repository.countPending();
      if (pending > 0) {
        // Предупреждение при каждом проходе: восстановление пароля при ненастроенной
        // почте молча не работает, и узнать об этом надо не от людей.
        this.logger.warn('Почта не настроена: письма копятся и не уходят', {
          pending,
          setting: 'mail.host',
        });
      }
      return 0;
    }

    let delivered = 0;

    // Отбор и отправка — в одной транзакции: строки заперты `for update skip locked`,
    // и второй экземпляр воркера возьмёт другие.
    await this.repository.db.transaction(async (tx) => {
      const due = await this.repository.claimDue(now, BATCH_LIMIT, tx);
      for (const message of due) {
        delivered += (await this.deliver(message, now, tx, mail)) ? 1 : 0;
      }
    });

    return delivered;
  }

  /** Убирает отправленные письма старше срока: в теле лежит одноразовый токен. */
  async purgeSent(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - SENT_RETENTION_DAYS * 86_400_000);
    return this.repository.deleteSentBefore(before);
  }

  /**
   * Пробное письмо из админки — **мимо очереди**, с ответом почтового сервера.
   *
   * Исключение из правила «письмо кладётся в базу» ([ADR-0029](../../../../../docs/adr/0029-pochta.md)),
   * и сделано осознанно: у пробного письма нет породившего события, которое надо
   * сохранить вместе с ним, а смысл кнопки ровно в том, чтобы увидеть отказ сервера
   * сразу, а не через полминуты в таблице. Предел писем на адрес
   * ([ADR-0030](../../../../../docs/adr/0030-predel-pisem-na-adres.md)) сюда не относится
   * по той же причине: адрес называет администратор, а не посторонний.
   */
  async sendTest(to: string): Promise<{ delivered: boolean; error: string | null }> {
    const mail = await this.settings.mail();
    if (mail.host === '') {
      throw validationFailed('Почта не настроена: задайте mail.host');
    }

    try {
      await this.connection(mail).sendMail({
        from: mail.from,
        to,
        subject: 'Zvonix: проверка почты',
        text: 'Если вы это читаете, почта площадки настроена верно.',
      });
      this.logger.info('Пробное письмо отправлено', { recipient: maskEmail(to) });
      return { delivered: true, error: null };
    } catch (cause) {
      // Текст ошибки возвращается администратору намеренно: без него «не работает»
      // неотличимо от «не тот пароль», и чинить приходится наугад.
      this.logger.error('Пробное письмо не отправлено', cause, { recipient: maskEmail(to) });
      return { delivered: false, error: String(cause).slice(0, 500) };
    }
  }

  onApplicationShutdown(): void {
    this.connected?.transport.close();
    this.connected = undefined;
  }

  private async deliver(
    message: OutboxMessageRow,
    now: Date,
    executor: Executor,
    mail: MailSettings,
  ): Promise<boolean> {
    try {
      await this.connection(mail).sendMail({
        from: mail.from,
        to: message.recipient,
        subject: message.subject,
        text: message.body,
      });
      await this.repository.markSent(message.id, now, executor);
      return true;
    } catch (cause) {
      const attempts = message.attempts + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      // Пауза удваивается: почтовый сервер, отвергающий письма пачкой, от частых
      // попыток не починится, а список отвергнутых вырастет.
      const retryAt = exhausted
        ? null
        : new Date(now.getTime() + RETRY_BASE_MS * 2 ** message.attempts);

      await this.repository.markFailure(
        message.id,
        { error: String(cause), retryAt, at: now },
        executor,
      );

      this.logger.error('Письмо не отправлено', cause, {
        kind: message.kind,
        recipient: maskEmail(message.recipient),
        attempts,
        exhausted,
      });
      return false;
    }
  }

  /**
   * Соединение с почтовым сервером.
   *
   * Заводится при первой отправке и переиспользуется: `nodemailer` держит пул
   * и сам переподключается. Заводить его при старте незачем — воркер может простоять
   * сутки без единого письма.
   */
  private connection(mail: MailSettings): Transporter {
    // Отпечаток настроек: изменились — соединение пересобирается. Иначе правка
    // в админке не действовала бы до перезапуска процесса, а это ровно то, ради чего
    // настройки туда и переехали.
    const signature = JSON.stringify([mail.host, mail.port, mail.secure, mail.user, mail.password]);
    if (this.connected?.signature === signature) return this.connected.transport;

    this.connected?.transport.close();
    const transport = createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      pool: true,
      ...SMTP_TIMEOUTS,
      ...(mail.user === '' ? {} : { auth: { user: mail.user, pass: mail.password } }),
    });

    this.connected = { transport, signature };
    return transport;
  }
}

/**
 * Маскирование адреса для журнала.
 *
 * Адрес — персональные данные, и в логе нужен опознаваемый след, а не сам адрес:
 * `iv***@example.com`.
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}
