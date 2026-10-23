/**
 * Сервер SMPP: слушатели, учёт сессий, защита от перебора, отчёты о доставке
 * ([ADR-0072](../../../../../../docs/adr/0072-smpp-dlya-soobscheniy.md)).
 *
 * Запускается **только** из `main.ts` API (`start()`): воркер подключает тот же модуль и читает тот же
 * файл окружения, и второй слушатель на том же порту уронил бы его при старте. Тесты запускают сервер
 * сами, на свободном порту.
 */

import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  SMPP_RECEIPT_EVENTS,
  type Id,
  type SmppEventKind,
  type SmppSubmitRefusal,
  type SmppReceiptAction,
  type SmppReceiptEvent,
  type SmppReceiptMap,
} from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../../infra/tokens.js';
import { MessagesRepository, type MessageRow } from '../messages.repository.js';
import { MessagesService } from '../messages.service.js';
import { Status, encodeReceiptBody, type Receipt } from './codec.js';
import type { SmppAccountRow } from './smpp.repository.js';
import { SmppService, normalizeIp } from './smpp.service.js';
import { SmppSession, type BindMode, type SessionHost } from './session.js';

/** Сессий на одну учётную запись, на один адрес и всего. */
const MAX_SESSIONS_PER_ACCOUNT = 5;
const MAX_SESSIONS_PER_IP = 20;
const MAX_SESSIONS_TOTAL = 500;

/** Неудачных входов с адреса за окно, после которых адрес не принимается до конца окна. */
const BIND_FAILURES_LIMIT = 5;
const BIND_FAILURE_WINDOW_MS = 60_000;

/** Как часто смотрим, нет ли отчётов для вошедших приёмников, и сколько берём за раз. */
const RECEIPT_POLL_MS = 3_000;
const RECEIPT_BATCH = 200;
/** Отчёты по сообщениям старше этого не отдаются: клиент, вернувшийся через неделю, их не ждёт. */
const RECEIPT_MAX_AGE_MS = 3 * 86_400_000;

/** Код причины в отчёте (`err:`) — наш, для разбора на стороне клиента. */
const ERROR_CODE: Record<NonNullable<MessageRow['failureReason']>, number> = {
  recipient_not_in_max: 1,
  account_unavailable: 2,
  wait_expired: 3,
  platform: 4,
  recipient_stopped: 5,
};

export interface ListenOptions {
  readonly host: string;
  readonly port: number;
  readonly tls?: { readonly cert: string; readonly key: string };
}

interface FailureRecord {
  count: number;
  since: number;
}

@Injectable()
export class SmppServer implements SessionHost, OnApplicationShutdown {
  private readonly logger: Logger;
  private readonly sessions = new Set<SmppSession>();
  private readonly listeners: net.Server[] = [];
  private readonly failures = new Map<string, FailureRecord>();
  /** Очередь записей журнала подключения (ADR-0096): одна за другой, чтобы повторы схлопывались. */
  private journalChain: Promise<void> = Promise.resolve();
  /** Отчёты, отправленные клиенту и ещё не подтверждённые: чтобы опрос не слал один и тот же дважды. */
  private readonly inFlight = new Set<string>();
  private pump: NodeJS.Timeout | undefined;
  private pumping = false;

  constructor(
    private readonly smpp: SmppService,
    private readonly messages: MessagesService,
    private readonly messageRows: MessagesRepository,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('smpp');
  }

  /** Слушатели по настройкам окружения. Порт `0` — выключено. */
  async start(): Promise<void> {
    const { SMPP_HOST: host, SMPP_PORT: port, SMPP_TLS_PORT: tlsPort } = this.config;
    if (port > 0) await this.listen({ host, port });
    if (tlsPort > 0) {
      const { SMPP_TLS_CERT_FILE: certFile, SMPP_TLS_KEY_FILE: keyFile } = this.config;
      if (certFile === '' || keyFile === '') {
        throw new Error('SMPP_TLS_PORT задан, а SMPP_TLS_CERT_FILE или SMPP_TLS_KEY_FILE — нет');
      }
      await this.listen({
        host,
        port: tlsPort,
        tls: { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') },
      });
    }
  }

  /** Поднимает один слушатель; возвращает порт, на котором он слушает (важно при порте `0`). */
  async listen(options: ListenOptions): Promise<number> {
    const onConnection = (socket: net.Socket): void => {
      this.accept(socket);
    };
    const server =
      options.tls === undefined
        ? net.createServer(onConnection)
        : tls.createServer(
            { cert: options.tls.cert, key: options.tls.key, minVersion: 'TLSv1.2' },
            onConnection,
          );
    server.on('error', (cause) => {
      this.logger.error('SMPP: ошибка слушателя', cause);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.listeners.push(server);
    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : options.port;
    this.logger.info('SMPP слушает', {
      host: options.host,
      port: bound,
      tls: options.tls !== undefined,
    });
    this.pump ??= setInterval(() => {
      void this.deliverReceipts();
    }, RECEIPT_POLL_MS);
    this.pump.unref();
    return bound;
  }

  async stop(): Promise<void> {
    if (this.pump !== undefined) clearInterval(this.pump);
    this.pump = undefined;
    for (const session of [...this.sessions]) session.destroy();
    await Promise.all(
      this.listeners.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  // --- Соединения ------------------------------------------------------------------------------

  private accept(socket: net.Socket): void {
    const ip = normalizeIp(socket.remoteAddress ?? '');
    const fromIp = [...this.sessions].filter((session) => session.ip === ip).length;
    if (
      this.isBlocked(ip) ||
      this.sessions.size >= MAX_SESSIONS_TOTAL ||
      fromIp >= MAX_SESSIONS_PER_IP
    ) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    this.sessions.add(new SmppSession(socket, ip, this, this.logger));
  }

  closed(session: SmppSession): void {
    this.sessions.delete(session);
  }

  private isBlocked(ip: string): boolean {
    const record = this.failures.get(ip);
    if (record === undefined) return false;
    if (Date.now() - record.since > BIND_FAILURE_WINDOW_MS) {
      this.failures.delete(ip);
      return false;
    }
    return record.count >= BIND_FAILURES_LIMIT;
  }

  /** Отмечает неудачный вход; `true` — этим входом адрес только что попал под паузу. */
  private noteFailure(ip: string): boolean {
    const now = Date.now();
    const record = this.failures.get(ip);
    let count = 1;
    if (record === undefined || now - record.since > BIND_FAILURE_WINDOW_MS) {
      this.failures.set(ip, { count: 1, since: now });
    } else {
      record.count += 1;
      count = record.count;
    }
    // Адресов-одноразовок может быть сколько угодно: старые записи не копятся.
    if (this.failures.size > 10_000) {
      for (const [address, entry] of this.failures) {
        if (now - entry.since > BIND_FAILURE_WINDOW_MS) this.failures.delete(address);
      }
    }
    return count === BIND_FAILURES_LIMIT;
  }

  /** Адреса на паузе за подбор пароля прямо сейчас — для «SMPP» у сотрудников (ADR-0096, дополнение 2026-10-23). */
  blockedAddresses(): { ip: string; failures: number; until: Date }[] {
    const now = Date.now();
    return [...this.failures.entries()].flatMap(([ip, record]) =>
      record.count >= BIND_FAILURES_LIMIT && now - record.since <= BIND_FAILURE_WINDOW_MS
        ? [{ ip, failures: record.count, until: new Date(record.since + BIND_FAILURE_WINDOW_MS) }]
        : [],
    );
  }

  /** Снять паузу с адреса раньше срока; `false` — паузы не было. */
  release(ip: string): boolean {
    return this.isBlocked(ip) && this.failures.delete(ip);
  }

  /**
   * Кто из клиента сейчас на связи — для «Сейчас на связи» в кабинете: программа такси сама о подключении ничего не говорит
   * (владелец, 2026-10-22). Сессии живут в памяти этого процесса — слушатель SMPP только в нём.
   */
  sessionsOf(clientId: Id<'client'>): { ip: string; mode: BindMode; since: Date }[] {
    return [...this.sessions].flatMap((session) =>
      session.clientId === clientId && session.mode !== undefined && session.boundAt !== undefined
        ? [{ ip: session.ip, mode: session.mode, since: session.boundAt }]
        : [],
    );
  }

  async bind(
    session: SmppSession,
    mode: BindMode,
    credentials: { systemId: string; password: string },
  ): Promise<{ status: number; clientId?: Id<'client'>; accountId?: SmppAccountRow['id'] }> {
    // Перебор с заблокированного адреса в журнал клиента не пишется: иначе он заливал бы журнал (ADR-0096).
    if (this.isBlocked(session.ip)) return { status: Status.bindFailed };

    const result = await this.smpp.authenticate(
      credentials.systemId,
      credentials.password,
      session.ip,
    );
    if (!result.ok) {
      // Неизвестное имя — в журнал площадки с введённым именем: по нему видно, кто стучится (ADR-0096, дополнение 2026-10-23).
      const typed = result.accountId === undefined ? credentials.systemId.slice(0, 16) : null;
      this.journal(
        result.accountId ?? null,
        'bind',
        result.refusal === 'unknown_system_id' ? 'unknown_login' : result.refusal,
        session.ip,
        mode,
        typed,
      );
      if (result.refusal !== 'unknown_system_id' && result.refusal !== 'wrong_password') {
        return { status: Status.bindFailed };
      }
      // Неизвестное имя и неверный пароль не различаются в ответе: иначе имена можно перебирать.
      // Адрес только что попал под паузу за подбор — один раз в журнал (ADR-0096): дальше его попытки не пишутся.
      if (this.noteFailure(session.ip)) {
        this.journal(result.accountId ?? null, 'bind', 'ip_blocked', session.ip, mode, typed);
      }
      this.logger.warn('SMPP: неверные данные для входа', { ip: session.ip });
      return { status: Status.invalidPassword };
    }
    const same = [...this.sessions].filter((other) => other.clientId === result.clientId).length;
    if (same >= MAX_SESSIONS_PER_ACCOUNT) {
      this.journal(result.accountId, 'bind', 'too_many_sessions', session.ip, mode);
      return { status: Status.bindFailed };
    }
    this.journal(result.accountId, 'bind', 'ok', session.ip, mode);
    return { status: Status.ok, clientId: result.clientId, accountId: result.accountId };
  }

  /** Отказ в приёме сообщения — в журнал подключения (ADR-0096). */
  refused(session: SmppSession, reason: SmppSubmitRefusal): void {
    if (session.accountId === undefined) return;
    this.journal(session.accountId, 'submit', reason, session.ip, session.mode ?? null);
  }

  /**
   * Журнал не задерживает ответ программе и не роняет сессию: запись идёт в фоне, сбой — строка в логе. Записи идут **по
   * очереди**: две одинаковые подряд иначе обе не нашли бы предыдущую и не схлопнулись бы в счётчик.
   */
  private journal(
    accountId: SmppAccountRow['id'] | null,
    kind: SmppEventKind,
    result: string,
    ip: string,
    mode: BindMode | null,
    systemId: string | null = null,
  ): void {
    this.journalChain = this.journalChain
      .then(() => this.smpp.record({ accountId, systemId, kind, result, ip, mode }))
      .catch((cause: unknown) => {
        this.logger.error('SMPP: событие журнала не записано', cause, { ip });
      });
  }

  async submit(
    clientId: Id<'client'>,
    to: string,
    text: string,
    validUntil?: Date,
  ): Promise<string> {
    const row = await this.messages.send(
      clientId,
      { to, text, ...(validUntil === undefined ? {} : { validUntil }) },
      'smpp',
    );
    return row.id;
  }

  // --- Отчёты о доставке -----------------------------------------------------------------------

  /**
   * Отдаёт отчёты по сообщениям SMPP вошедшим приёмникам клиентов. Работает от базы, а не от событий:
   * статусы меняет воркер — другой процесс, и «хотя бы раз» держится на отметках `receipt_events`.
   */
  async deliverReceipts(): Promise<number> {
    if (this.pumping) return 0;
    this.pumping = true;
    try {
      const receivers = new Map<Id<'client'>, SmppSession[]>();
      for (const session of this.sessions) {
        if (session.canReceive && session.clientId !== undefined) {
          receivers.set(session.clientId, [...(receivers.get(session.clientId) ?? []), session]);
        }
      }
      const rows = await this.messageRows.pendingReceipts(
        [...receivers.keys()],
        new Date(Date.now() - RECEIPT_MAX_AGE_MS),
        RECEIPT_BATCH,
      );
      let started = 0;
      for (const { message: row, map } of rows) {
        if (this.inFlight.has(row.id)) continue;
        const session = receivers
          .get(row.clientId)
          ?.find((candidate) => candidate.hasDeliverCapacity);
        if (session === undefined) continue;
        this.inFlight.add(row.id);
        started += 1;
        void this.deliverFor(session, row, map)
          .catch((cause: unknown) => {
            this.logger.error('SMPP: отчёт о доставке не отмечен', cause, { message_id: row.id });
          })
          .finally(() => {
            this.inFlight.delete(row.id);
          });
      }
      return started;
    } catch (cause) {
      this.logger.error('SMPP: опрос отчётов не удался', cause);
      return 0;
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Отчёты одного сообщения по настройкам клиента ([ADR-0076](../../../../../../docs/adr/0076-statusy-smpp-po-nastrojkam-klienta.md)):
   * наступившие события — по порядку «ушло → доставлено → прочитано», один и тот же итог один раз, отказ — всегда.
   * Обработанным событие считается, когда клиент принял отчёт (или отчёт не нужен); не принял — вернёмся на
   * следующем проходе.
   */
  private async deliverFor(
    session: SmppSession,
    row: MessageRow,
    map: SmppReceiptMap,
  ): Promise<void> {
    const handled = new Set<string>(row.receiptEvents);
    const given = new Set<SmppReceiptAction>(
      SMPP_RECEIPT_EVENTS.filter((event) => handled.has(event)).map((event) => map[event]),
    );
    for (const event of SMPP_RECEIPT_EVENTS) {
      const action = map[event];
      if (handled.has(event) || action === 'none' || !reached(row, event)) continue;
      if (given.has(action)) {
        await this.messageRows.markReceiptEvent(row.id, event, null);
        continue;
      }
      if (!session.hasDeliverCapacity) return;
      const receipt = this.receiptOf(row, action === 'accepted' ? 'ACCEPTD' : 'DELIVRD', event);
      const status = await session.sendDeliver(encodeReceiptBody(receipt));
      if (status !== Status.ok) return;
      await this.messageRows.markReceiptEvent(row.id, event, new Date());
      given.add(action);
    }
    if (row.status === 'failed' && !handled.has('failed')) {
      if (!session.hasDeliverCapacity) return;
      const reason = row.failureReason;
      const state = reason === 'wait_expired' ? 'EXPIRED' : 'UNDELIV';
      const status = await session.sendDeliver(encodeReceiptBody(this.receiptOf(row, state, null)));
      if (status === Status.ok)
        await this.messageRows.markReceiptEvent(row.id, 'failed', new Date());
    }
  }

  private receiptOf(
    row: MessageRow,
    state: Receipt['state'],
    event: SmppReceiptEvent | null,
  ): Receipt {
    const reason = row.failureReason;
    const at =
      event === 'sent'
        ? row.sentAt
        : event === 'delivered'
          ? (row.deliveredAt ?? row.sentAt)
          : event === 'read'
            ? (row.readAt ?? row.deliveredAt ?? row.sentAt)
            : row.failedAt;
    return {
      messageId: row.id,
      recipient: row.recipient,
      submittedAt: row.createdAt,
      doneAt: at ?? row.createdAt,
      state,
      error: reason === null || event !== null ? 0 : ERROR_CODE[reason],
    };
  }
}

/** Наступило ли событие у сообщения: статусы идут только вперёд, поэтому «прочитано» значит и «доставлено». */
function reached(row: MessageRow, event: SmppReceiptEvent): boolean {
  switch (event) {
    case 'sent':
      return row.status === 'sent' || row.status === 'delivered' || row.status === 'read';
    case 'delivered':
      return row.status === 'delivered' || row.status === 'read';
    case 'read':
      return row.status === 'read';
  }
}
