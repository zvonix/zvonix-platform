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
  validationFailed,
  type Id,
  type SmppReceiptMap,
} from '@zvonix/shared';
import { AuditService } from '../../audit/audit.service.js';
import { BillingService } from '../../billing/billing.service.js';
import type { Principal } from '../../identity/identity.service.js';
import { MessagingService } from '../messaging.service.js';
import { SmppRepository, type SmppAccountRow } from './smpp.repository.js';

/** Без неоднозначных знаков (0/O, 1/l/I): пароль переписывают руками и диктуют по телефону. */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD_LENGTH = 16;
const SYSTEM_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Почему вход отклонён: SMPP-сервер превращает это в код ответа, клиенту подробности не нужны. */
type BindRefusal = 'unknown_system_id' | 'wrong_password' | 'refused';

export type BindResult =
  | { readonly ok: true; readonly clientId: Id<'client'>; readonly accountId: SmppAccountRow['id'] }
  | { readonly ok: false; readonly refusal: BindRefusal };

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
    if (!matches) return { ok: false, refusal: 'wrong_password' };

    if (!account.enabled) return { ok: false, refusal: 'refused' };
    if (
      account.allowedIps.length > 0 &&
      !account.allowedIps.some((allowed) => allowed === normalizeIp(ip))
    ) {
      return { ok: false, refusal: 'refused' };
    }
    if (!(await this.messaging.isEnabled())) return { ok: false, refusal: 'refused' };
    const client = await this.billing.clientWithBalance(account.clientId);
    if (client.status !== 'active') return { ok: false, refusal: 'refused' };

    await this.repository.touchBind(account.id, new Date());
    return { ok: true, clientId: account.clientId, accountId: account.id };
  }
}
