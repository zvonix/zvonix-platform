/**
 * Одно подключение SMPP ([ADR-0072](../../../../../../docs/adr/0072-smpp-dlya-soobscheniy.md)).
 *
 * Сессия знает протокол: разбирает PDU, ведёт состояние «не вошла / вошла», собирает длинный текст
 * из частей, ограничивает частоту и очередь. Что такое клиент, деньги и сообщение — не знает: это
 * делает `SessionHost` (сервер). Исключения наружу не летят: сбой одной сессии не должен ронять API.
 */

import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { isDomainError, MESSAGE_MAX_LENGTH, normalizeMsisdn, type Id } from '@zvonix/shared';
import type { Logger } from '../../../infra/tokens.js';
import {
  bindResponseBody,
  cString,
  Command,
  decodeBind,
  decodeSubmit,
  encodePdu,
  encodeResponse,
  PduFramer,
  RESPONSE_BIT,
  SmppProtocolError,
  Status,
  type Pdu,
  type SubmitRequest,
} from './codec.js';

export type BindMode = 'transmitter' | 'receiver' | 'transceiver';

/** Что сессии нужно от сервера. */
export interface SessionHost {
  /** Проверяет вход. `status` — код ответа; при успехе сессия становится привязанной к клиенту. */
  bind(
    session: SmppSession,
    mode: BindMode,
    credentials: { systemId: string; password: string },
  ): Promise<{ status: number; clientId?: Id<'client'> }>;
  /** Принимает сообщение клиента; возвращает его идентификатор. Бросает доменную ошибку при отказе. */
  submit(clientId: Id<'client'>, to: string, text: string): Promise<string>;
  closed(session: SmppSession): void;
}

/** Не вошедшая за это время сессия закрывается. */
const BIND_TIMEOUT_MS = 10_000;
/** Тишина дольше этого — разрыв; сами шлём проверку связи через `KEEPALIVE_MS` тишины. */
const IDLE_TIMEOUT_MS = 90_000;
const KEEPALIVE_MS = 30_000;
const TICK_MS = 5_000;
/** Сообщений в секунду с одной сессии; сверх — `ESME_RTHROTTLED`, клиент повторяет сам. */
const SUBMITS_PER_SECOND = 50;
/** Принятых, но ещё не обработанных `submit_sm`; сверх — отказ без обработки. */
const MAX_QUEUED_SUBMITS = 100;
/** Незаконченных длинных текстов на сессию и время ожидания остальных частей. */
const MAX_OPEN_GROUPS = 20;
const GROUP_TTL_MS = 60_000;
/** Неподтверждённых отчётов в полёте и время ожидания подтверждения. */
const MAX_DELIVER_IN_FLIGHT = 50;
const DELIVER_TIMEOUT_MS = 30_000;
/** Если сокет не успевает за записью, а накопилось больше этого, клиента отключают. */
const MAX_WRITE_BACKLOG = 1_048_576;

interface PartGroup {
  readonly total: number;
  readonly parts: Map<number, string>;
  readonly startedAt: number;
}

export class SmppSession {
  mode: BindMode | undefined;
  clientId: Id<'client'> | undefined;

  private readonly framer = new PduFramer();
  private readonly groups = new Map<string, PartGroup>();
  private readonly awaitingAck = new Map<number, (status: number) => void>();
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private windowStart = 0;
  private windowCount = 0;
  private lastActivity = Date.now();
  private outSequence = 1;
  private closed = false;
  private binding = false;
  private readonly bindTimer: NodeJS.Timeout;
  private readonly tick: NodeJS.Timeout;

  constructor(
    private readonly socket: Duplex,
    readonly ip: string,
    private readonly host: SessionHost,
    private readonly logger: Logger,
  ) {
    this.bindTimer = setTimeout(() => {
      this.logger.warn('SMPP: вход не выполнен вовремя', { ip });
      this.destroy();
    }, BIND_TIMEOUT_MS);
    this.tick = setInterval(() => {
      this.onTick();
    }, TICK_MS);
    this.bindTimer.unref();
    this.tick.unref();

    socket.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on('error', () => {
      this.destroy();
    });
    socket.on('close', () => {
      this.destroy();
    });
  }

  get canSubmit(): boolean {
    return this.mode === 'transmitter' || this.mode === 'transceiver';
  }

  get canReceive(): boolean {
    return this.mode === 'receiver' || this.mode === 'transceiver';
  }

  get hasDeliverCapacity(): boolean {
    return !this.closed && this.awaitingAck.size < MAX_DELIVER_IN_FLIGHT;
  }

  /** Отправляет клиенту `deliver_sm`; ответ — код результата, либо `undefined`, если ответа не было. */
  sendDeliver(body: Buffer): Promise<number | undefined> {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve(undefined);
        return;
      }
      const sequence = this.nextSequence();
      const timer = setTimeout(() => {
        this.awaitingAck.delete(sequence);
        resolve(undefined);
      }, DELIVER_TIMEOUT_MS);
      timer.unref();
      this.awaitingAck.set(sequence, (status) => {
        clearTimeout(timer);
        resolve(status);
      });
      this.write(encodePdu(Command.deliverSm, Status.ok, sequence, body));
    });
  }

  /** Закрывает соединение (идемпотентно) и сообщает серверу. */
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.bindTimer);
    clearInterval(this.tick);
    for (const resolve of this.awaitingAck.values()) resolve(Status.systemError);
    this.awaitingAck.clear();
    this.socket.destroy();
    this.host.closed(this);
  }

  private nextSequence(): number {
    const value = this.outSequence;
    this.outSequence = (this.outSequence % 0x7fffffff) + 1;
    return value;
  }

  private write(buffer: Buffer): void {
    if (this.closed) return;
    if (this.socket.writableLength > MAX_WRITE_BACKLOG) {
      this.destroy();
      return;
    }
    this.socket.write(buffer);
  }

  private respond(request: Pdu, status: number, body?: Buffer): void {
    this.write(encodeResponse(request.commandId, status, request.sequence, body));
  }

  private onTick(): void {
    const idle = Date.now() - this.lastActivity;
    if (idle > IDLE_TIMEOUT_MS) {
      this.logger.info('SMPP: сессия молчит, закрываем', { ip: this.ip });
      this.destroy();
      return;
    }
    if (this.mode !== undefined && idle > KEEPALIVE_MS) {
      this.write(encodePdu(Command.enquireLink, Status.ok, this.nextSequence(), Buffer.alloc(0)));
    }
    const now = Date.now();
    for (const [key, group] of this.groups) {
      if (now - group.startedAt > GROUP_TTL_MS) {
        this.groups.delete(key);
        this.logger.warn('SMPP: длинный текст не дождался всех частей, отброшен', {
          received: group.parts.size,
          total: group.total,
        });
      }
    }
  }

  private onData(chunk: Buffer): void {
    this.lastActivity = Date.now();
    let pdus: Pdu[];
    try {
      pdus = this.framer.push(chunk);
    } catch (cause) {
      // Поток испорчен: разобрать дальше нечего. Ответ — одно `generic_nack`, и разрыв.
      const status = cause instanceof SmppProtocolError ? cause.status : Status.systemError;
      this.write(encodePdu(Command.genericNack, status, 0, Buffer.alloc(0)));
      this.destroy();
      return;
    }
    for (const pdu of pdus) {
      this.handle(pdu).catch((cause: unknown) => {
        this.logger.error('SMPP: сбой разбора операции', cause, { ip: this.ip });
        this.respond(pdu, Status.systemError);
      });
    }
  }

  private async handle(pdu: Pdu): Promise<void> {
    if ((pdu.commandId & RESPONSE_BIT) !== 0) {
      // Ответ на наш `deliver_sm` — единственный, которого мы ждём; остальные ответы безразличны.
      if (pdu.commandId === (Command.deliverSm | RESPONSE_BIT) >>> 0) {
        const waiter = this.awaitingAck.get(pdu.sequence);
        if (waiter !== undefined) {
          this.awaitingAck.delete(pdu.sequence);
          waiter(pdu.status);
        }
      }
      return;
    }

    switch (pdu.commandId) {
      case Command.enquireLink:
        this.respond(pdu, Status.ok);
        return;
      case Command.unbind:
        this.respond(pdu, Status.ok);
        // Ответ уходит до закрытия: `end` дописывает буфер, `destroy` бы его отбросил.
        this.socket.end();
        return;
      case Command.bindReceiver:
        await this.bind(pdu, 'receiver');
        return;
      case Command.bindTransmitter:
        await this.bind(pdu, 'transmitter');
        return;
      case Command.bindTransceiver:
        await this.bind(pdu, 'transceiver');
        return;
      case Command.submitSm:
        this.enqueueSubmit(pdu);
        return;
      default:
        // Операция, которую мы не поддерживаем (или не ждём от клиента, как `deliver_sm`).
        this.write(
          encodePdu(
            Command.genericNack,
            this.mode === undefined ? Status.incorrectBindStatus : Status.invalidCommandId,
            pdu.sequence,
            Buffer.alloc(0),
          ),
        );
    }
  }

  private async bind(pdu: Pdu, mode: BindMode): Promise<void> {
    // Второй `bind` сразу за первым приходит, пока первый ещё проверяется: тоже «уже вошёл».
    if (this.mode !== undefined || this.binding) {
      this.respond(pdu, Status.alreadyBound);
      return;
    }
    let credentials: { systemId: string; password: string };
    try {
      credentials = decodeBind(pdu.body);
    } catch (cause) {
      this.respond(pdu, cause instanceof SmppProtocolError ? cause.status : Status.systemError);
      return;
    }
    this.binding = true;
    let result: Awaited<ReturnType<SessionHost['bind']>>;
    try {
      result = await this.host.bind(this, mode, credentials);
    } finally {
      this.binding = false;
    }
    if (result.status !== Status.ok || result.clientId === undefined) {
      this.respond(pdu, result.status);
      // После отказа сессия не нужна: ждать вторую попытку на том же соединении незачем.
      this.socket.end();
      return;
    }
    this.mode = mode;
    this.clientId = result.clientId;
    clearTimeout(this.bindTimer);
    this.respond(pdu, Status.ok, bindResponseBody('zvonix'));
  }

  private enqueueSubmit(pdu: Pdu): void {
    if (this.mode === undefined || !this.canSubmit || this.clientId === undefined) {
      this.respond(pdu, Status.incorrectBindStatus);
      return;
    }
    if (this.queued >= MAX_QUEUED_SUBMITS || !this.withinRate()) {
      this.respond(pdu, Status.throttled);
      return;
    }
    const clientId = this.clientId;
    this.queued += 1;
    // Один за другим: порядок сообщений клиента сохраняется, а база не получает сотню одновременных.
    this.chain = this.chain.then(async () => {
      try {
        await this.processSubmit(pdu, clientId);
      } catch (cause) {
        this.logger.error('SMPP: сбой приёма сообщения', cause, { ip: this.ip });
        this.respond(pdu, Status.systemError);
      } finally {
        this.queued -= 1;
      }
    });
  }

  private withinRate(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    return this.windowCount <= SUBMITS_PER_SECOND;
  }

  private async processSubmit(pdu: Pdu, clientId: Id<'client'>): Promise<void> {
    let request: SubmitRequest;
    try {
      request = decodeSubmit(pdu.body);
    } catch (cause) {
      this.respond(pdu, cause instanceof SmppProtocolError ? cause.status : Status.systemError);
      return;
    }

    let text = request.text;
    if (request.part !== undefined && request.part.total > 1) {
      const assembled = this.assemble(request);
      if (assembled === null) {
        this.respond(pdu, Status.throttled);
        return;
      }
      if (assembled === undefined) {
        // Часть принята, текст ещё не полон: идентификатор условный, настоящий придёт с последней.
        this.respond(pdu, Status.ok, cString(`part-${randomUUID()}`.slice(0, 40)));
        return;
      }
      text = assembled;
    }

    if (normalizeMsisdn(request.destination) === undefined) {
      this.respond(pdu, Status.invalidDestination);
      return;
    }
    if (text.trim() === '' || text.length > MESSAGE_MAX_LENGTH) {
      this.respond(pdu, Status.invalidMessageLength);
      return;
    }

    try {
      const id = await this.host.submit(clientId, request.destination, text);
      this.respond(pdu, Status.ok, cString(id));
    } catch (cause) {
      this.respond(pdu, this.statusOf(cause));
    }
  }

  /** Склеивает часть с остальными; `undefined` — ещё не все, строка — готовый текст. */
  /** `undefined` — ещё не все части, `null` — открытых длинных текстов слишком много. */
  private assemble(request: SubmitRequest): string | undefined | null {
    const part = request.part;
    if (part === undefined) return request.text;
    const key = `${request.destination}|${String(part.reference)}`;
    let group = this.groups.get(key);
    if (group === undefined) {
      if (this.groups.size >= MAX_OPEN_GROUPS) return null;
      group = { total: part.total, parts: new Map(), startedAt: Date.now() };
      this.groups.set(key, group);
    }
    group.parts.set(part.sequence, request.text);
    if (group.parts.size < group.total) return undefined;
    this.groups.delete(key);
    return Array.from(
      { length: group.total },
      (_unused, index) => group.parts.get(index + 1) ?? '',
    ).join('');
  }

  private statusOf(cause: unknown): number {
    if (isDomainError(cause)) {
      if (cause.code === 'conflict' || cause.code === 'validation_failed')
        return Status.submitFailed;
      if (cause.code === 'dependency_unavailable' || cause.code === 'rate_limited') {
        return Status.throttled;
      }
    }
    this.logger.error('SMPP: сообщение не принято', cause, { ip: this.ip });
    return Status.systemError;
  }
}
