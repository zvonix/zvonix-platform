/**
 * Учётная запись SMPP клиента: выдача, смена пароля, проверка при подключении
 * ([ADR-0072](../../../../../../docs/adr/0072-smpp-dlya-soobscheniy.md)).
 *
 * Пароль показывается один раз и хранится как SHA-256 с солью `system_id` (как ключи машин, ADR-0019):
 * проверка идёт на каждое подключение, а перебирать 95 бит случайности нечего.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import {
  conflict,
  notFound,
  SMPP_ALLOWED_IPS_MAX,
  SMPP_EVENTS_KEEP_DAYS,
  validationFailed,
  type Id,
  type SmppBindMode,
  type SmppBindResult,
  type SmppEventKind,
  type SmppReceiptMap,
} from '@zvonix/shared';
import { AuditService } from '../../audit/audit.service.js';
import { BillingService } from '../../billing/billing.service.js';
import type { Principal } from '../../identity/identity.service.js';
import { MessagingService } from '../messaging.service.js';
import { SmppEventsRepository } from './smpp-events.repository.js';
import { SmppRepository, type SmppAccountRow } from './smpp.repository.js';

/** Без неоднозначных знаков (0/O, 1/l/I): пароль переписывают руками и диктуют по телефону. */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/**
 * Восемь — предел SMPP 3.4 (5.2.4: `password` — C-Octet String до 9 октетов с завершающим нулём). Шестнадцать знаков
 * программа такси владельца отказалась даже отправлять (2026-10-22, «length must be less than 9»). Перебор держат пауза
 * адреса после 5 неверных паролей и список разрешённых адресов, а не длина.
 */
const PASSWORD_LENGTH = 8;
const SYSTEM_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Почему вход отклонён. SMPP-сервер превращает это в общий код ответа (имена не перебрать по ответам), а подробность пишет
 * в журнал подключения (ADR-0096) — кроме неизвестного имени: его не к чему привязать.
 */
type BindRefusal =
  'unknown_system_id' | Exclude<SmppBindResult, 'ok' | 'too_many_sessions' | 'ip_blocked'>;

export type BindResult =
  | { readonly ok: true; readonly clientId: Id<'client'>; readonly accountId: SmppAccountRow['id'] }
  | {
      readonly ok: false;
      readonly refusal: BindRefusal;
      /** Подключение, к которому относится отказ; нет — имя неизвестно. */
      readonly accountId?: SmppAccountRow['id'];
    };

/** Событие журнала так, как его видит клиент и сотрудник. */
export interface SmppEventView {
  readonly kind: SmppEventKind;
  readonly result: string;
  readonly ip: string;
  readonly mode: SmppBindMode | null;
  readonly count: number;
  readonly first_at: string;
  readonly last_at: string;
}

/** Сколько событий журнала показывается. */
const EVENTS_SHOWN = 100;
/** Журнал площадки: больше, чем у клиента, — в нём все подключения сразу. */
const PLATFORM_EVENTS_SHOWN = 300;

const pick = (alphabet: string, length: number): string =>
  Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');

const hashOf = (systemId: string, password: string): Buffer =>
  createHash('sha256').update(`${systemId}\n${password}`).digest();

/** Настройки отчётов подключения одним значением: для ответа API и журнала. */
export const receiptsOf = (row: SmppAccountRow): SmppReceiptMap => ({
  sent: row.receiptOnSent,
  delivered: row.receiptOnDelivered,
  read: row.receiptOnRead,
});

/** Адрес без обёртки IPv4-в-IPv6 (`::ffff:1.2.3.4`) и в нижнем регистре: так же хранится список. */
export const normalizeIp = (ip: string): string =>
  ip
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/u, '');

@Injectable()
export class SmppService {
  constructor(
    private readonly repository: SmppRepository,
    private readonly events: SmppEventsRepository,
    private readonly messaging: MessagingService,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
  ) {}

  /** Все подключения — для сотрудников. */
  list(): Promise<SmppAccountRow[]> {
    return this.repository.list();
  }

  find(clientId: Id<'client'>): Promise<SmppAccountRow | undefined> {
    return this.repository.findByClient(clientId);
  }

  /** Создаёт учётную запись клиента. Пароль возвращается здесь и больше нигде. */
  async create(
    actor: Principal,
    clientId: Id<'client'>,
  ): Promise<{ account: SmppAccountRow; password: string }> {
    await this.messaging.assertEnabled();
    if ((await this.repository.findByClient(clientId)) !== undefined) {
      throw conflict('Подключение по SMPP уже создано');
    }
    const password = pick(PASSWORD_ALPHABET, PASSWORD_LENGTH);
    // Имя случайное: редкое совпадение устраняется повтором, а не проверкой наперёд.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const systemId = `zx${pick(SYSTEM_ID_ALPHABET, 8)}`;
      if ((await this.repository.findBySystemId(systemId)) !== undefined) continue;
      const account = await this.repository.insert({
        clientId,
        systemId,
        passwordHash: hashOf(systemId, password).toString('hex'),
      });
      await this.audit.record({
        action: 'smpp_account.created',
        entityType: 'smpp_account',
        entityId: account.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        after: { client_id: clientId, system_id: systemId },
      });
      return { account, password };
    }
    throw new Error('Не удалось подобрать свободное имя для SMPP');
  }

  /** Новый пароль: прежний перестаёт действовать, открытые сессии доживают до разрыва. */
  async resetPassword(
    actor: Principal,
    clientId: Id<'client'>,
  ): Promise<{ account: SmppAccountRow; password: string }> {
    const current = await this.require(clientId);
    const password = pick(PASSWORD_ALPHABET, PASSWORD_LENGTH);
    const account = await this.repository.update(clientId, {
      passwordHash: hashOf(current.systemId, password).toString('hex'),
    });
    if (account === undefined) throw notFound('Подключение по SMPP не найдено');
    await this.audit.record({
      action: 'smpp_account.password_reset',
      entityType: 'smpp_account',
      entityId: account.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
    return { account, password };
  }

  async update(
    actor: Principal,
    clientId: Id<'client'>,
    patch: {
      enabled?: boolean | undefined;
      allowedIps?: string[] | undefined;
      receipts?: SmppReceiptMap | undefined;
    },
  ): Promise<SmppAccountRow> {
    const before = await this.require(clientId);
    const allowedIps = patch.allowedIps === undefined ? undefined : this.validIps(patch.allowedIps);
    const account = await this.repository.update(clientId, {
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(allowedIps === undefined ? {} : { allowedIps }),
      ...(patch.receipts === undefined
        ? {}
        : {
            receiptOnSent: patch.receipts.sent,
            receiptOnDelivered: patch.receipts.delivered,
            receiptOnRead: patch.receipts.read,
          }),
    });
    if (account === undefined) throw notFound('Подключение по SMPP не найдено');
    await this.audit.record({
      action: 'smpp_account.updated',
      entityType: 'smpp_account',
      entityId: account.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: {
        enabled: before.enabled,
        allowed_ips: before.allowedIps,
        receipts: receiptsOf(before),
      },
      after: {
        enabled: account.enabled,
        allowed_ips: account.allowedIps,
        receipts: receiptsOf(account),
      },
    });
    return account;
  }

  private async require(clientId: Id<'client'>): Promise<SmppAccountRow> {
    const account = await this.repository.findByClient(clientId);
    if (account === undefined) throw notFound('Подключение по SMPP не создано');
    return account;
  }

  private validIps(raw: string[]): string[] {
    const unique = [...new Set(raw.map(normalizeIp).filter((ip) => ip !== ''))];
    if (unique.length > SMPP_ALLOWED_IPS_MAX) {
      throw validationFailed(`Разрешённых адресов — не больше ${String(SMPP_ALLOWED_IPS_MAX)}`);
    }
    const bad = unique.find((ip) => isIP(ip) === 0);
    if (bad !== undefined) throw validationFailed(`«${bad}» — не адрес IPv4 или IPv6`);
    return unique;
  }

  /**
   * Проверка при подключении. Сравнение выполняется всегда, есть такое имя или нет: иначе по скорости
   * ответа можно перебирать имена.
   */
  async authenticate(systemId: string, password: string, ip: string): Promise<BindResult> {
    const account = await this.repository.findBySystemId(systemId);
    const expected = Buffer.from(account?.passwordHash ?? '0'.repeat(64), 'hex');
    const matches = timingSafeEqual(expected, hashOf(systemId, password));
    if (account === undefined) return { ok: false, refusal: 'unknown_system_id' };
    const refuse = (refusal: BindRefusal): BindResult => ({
      ok: false,
      refusal,
      accountId: account.id,
    });
    if (!matches) return refuse('wrong_password');

    if (!account.enabled) return refuse('disabled');
    if (
      account.allowedIps.length > 0 &&
      !account.allowedIps.some((allowed) => allowed === normalizeIp(ip))
    ) {
      return refuse('ip_not_allowed');
    }
    if (!(await this.messaging.isEnabled())) return refuse('product_off');
    const client = await this.billing.clientWithBalance(account.clientId);
    if (client.status !== 'active') return refuse('client_inactive');

    await this.repository.touchBind(account.id, new Date());
    return { ok: true, clientId: account.clientId, accountId: account.id };
  }

  /** Запись в журнал подключения (ADR-0096). Сбой записи не мешает работе SMPP — журнал вспомогательный. */
  async record(event: {
    accountId: SmppAccountRow['id'] | null;
    systemId: string | null;
    kind: SmppEventKind;
    result: string;
    ip: string;
    mode: SmppBindMode | null;
  }): Promise<void> {
    await this.events.record({ ...event, ip: normalizeIp(event.ip) }, new Date());
  }

  /** Журнал подключения клиента; подключения нет — `404`. */
  async eventsOf(clientId: Id<'client'>): Promise<SmppEventView[]> {
    const account = await this.repository.findByClient(clientId);
    if (account === undefined) throw notFound('Подключения SMPP нет');
    return (await this.events.list(account.id, EVENTS_SHOWN)).map((row) => ({
      kind: row.kind,
      result: row.result,
      ip: row.ip,
      mode: row.mode,
      count: row.count,
      first_at: row.createdAt.toISOString(),
      last_at: row.lastAt.toISOString(),
    }));
  }

  /** Снятие паузы с адреса — в журнал действий: администратор пустил адрес, который подбирал пароль. */
  async auditRelease(actor: Principal, ip: string): Promise<void> {
    await this.audit.record({
      action: 'smpp_ip.released',
      entityType: 'smpp_ip',
      actorUserId: actor.userId,
      actorRole: actor.role,
      after: { ip },
    });
  }

  /** Журнал площадки — сотрудникам: и входы с неизвестным именем, которых нет ни в одном журнале клиента. */
  async platformEvents(): Promise<
    (SmppEventView & {
      client_name: string | null;
      system_id: string | null;
    })[]
  > {
    return (await this.events.listAll(PLATFORM_EVENTS_SHOWN)).map((row) => ({
      kind: row.kind,
      result: row.result,
      ip: row.ip,
      mode: row.mode,
      count: row.count,
      first_at: row.createdAt.toISOString(),
      last_at: row.lastAt.toISOString(),
      client_name: row.clientName,
      system_id: row.systemId,
    }));
  }

  /** Стирает журнал старше срока — фоновая задача (догоняющая, по сроку — ADR-0020). */
  purgeEvents(now: Date): Promise<number> {
    return this.events.purge(new Date(now.getTime() - SMPP_EVENTS_KEEP_DAYS * 86_400_000));
  }
}
