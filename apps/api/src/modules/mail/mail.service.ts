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
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { MailRepository, type Executor, type OutboxMessageRow } from './mail.repository.js';

/** Сколько писем берётся за один проход. */
const BATCH_LIMIT = 50;

/** После стольких неудач письмо перестаёт пытаться уйти и помечается неотправленным. */
const MAX_ATTEMPTS = 6;

/** Пауза перед первой повторной попыткой. Дальше удваивается. */
const RETRY_BASE_MS = 60_000;

/** Сколько дней хранятся отправленные письма: в теле лежит одноразовый токен. */
const SENT_RETENTION_DAYS = 14;

@Injectable()
export class MailService implements OnApplicationShutdown {
  private readonly logger: Logger;
  private transport: Transporter | undefined;

  constructor(
    private readonly repository: MailRepository,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('mail');
  }

  /** Настроена ли почта. Пусто — письма копятся, но не уходят (ADR-0029). */
  get configured(): boolean {
    return this.config.SMTP_HOST !== '';
  }

  /**
   * Кладёт письмо в очередь.
   *
   * `executor` передаётся тем, кто пишет письмо вместе с событием.
   */
  async enqueue(
    message: { recipient: string; subject: string; body: string; kind: string },
    executor?: Executor,
  ): Promise<void> {
    // Тело письма в лог не попадает: в нём одноразовый токен, а лог живёт дольше письма.
    await this.repository.enqueue(message, executor);
    this.logger.info('Письмо поставлено в очередь', {
      kind: message.kind,
      recipient: maskEmail(message.recipient),
    });
  }

  /**
   * Отправляет то, чему пора уходить.
   *
   * Проход догоняющий: письма отбираются **по сроку**, а не «появившиеся с прошлого
   * запуска» ([ADR-0020](../../../../../docs/adr/0020-fonovye-zadachi.md)). Пропущенный
   * тик ничего не теряет.
   */
  async deliverDue(now: Date = new Date()): Promise<number> {
    if (!this.configured) {
      const pending = await this.repository.countPending();
      if (pending > 0) {
        // Предупреждение при каждом проходе: восстановление пароля при ненастроенной
        // почте молча не работает, и узнать об этом надо не от людей.
        this.logger.warn('Почта не настроена: письма копятся и не уходят', {
          pending,
          variable: 'SMTP_HOST',
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
        delivered += (await this.deliver(message, now, tx)) ? 1 : 0;
      }
    });

    return delivered;
  }

  /** Убирает отправленные письма старше срока: в теле лежит одноразовый токен. */
  async purgeSent(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - SENT_RETENTION_DAYS * 86_400_000);
    return this.repository.deleteSentBefore(before);
  }

  onApplicationShutdown(): void {
    this.transport?.close();
    this.transport = undefined;
  }

  private async deliver(
    message: OutboxMessageRow,
    now: Date,
    executor: Executor,
  ): Promise<boolean> {
    try {
      await this.connection().sendMail({
        from: this.config.SMTP_FROM,
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
  private connection(): Transporter {
    this.transport ??= createTransport({
      host: this.config.SMTP_HOST,
      port: this.config.SMTP_PORT,
      secure: this.config.SMTP_SECURE,
      pool: true,
      ...(this.config.SMTP_USER === ''
        ? {}
        : { auth: { user: this.config.SMTP_USER, pass: this.config.SMTP_PASSWORD } }),
    });
    return this.transport;
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
