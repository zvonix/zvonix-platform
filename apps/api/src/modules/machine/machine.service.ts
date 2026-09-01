/**
 * Правила машинного доступа (ADR-0019).
 *
 * Субъект здесь — не человек, а узел или клиентская интеграция. Роли людей машинному
 * ключу не выдаются ни при каких условиях: иначе ключ, украденный с узла, превращается
 * в администратора платформы.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  notFound,
  unauthenticated,
  type Id,
  type MachineKeyKind,
  type UserRole,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import {
  CLIENT_KEY_TTL_MS,
  ENROLLMENT_TTL_MS,
  hashSecret,
  ipAllowed,
  issueKey,
  LAST_USED_REFRESH_MS,
  secretHashEquals,
  type IssuedKey,
  type PresentedKey,
} from './machine-key.js';
import { MachineRepository, type MachineKeyId, type MachineKeyRow } from './machine.repository.js';

/**
 * Хеш, с которым сравнивается секрет, когда ключа с таким идентификатором нет.
 *
 * Нужен, чтобы отсутствие ключа занимало столько же времени, сколько неверный секрет:
 * иначе по времени ответа перебираются существующие идентификаторы.
 */
const ABSENT_KEY_HASH = hashSecret('отсутствующий ключ');

/** Проверенная машина. Роли пользователя здесь нет и быть не может. */
export interface MachinePrincipal {
  readonly credentialId: MachineKeyId;
  readonly keyId: string;
  readonly kind: MachineKeyKind;
  /** Узел или клиент. У одноразового токена установки владельца ещё нет. */
  readonly ownerId: string | null;
}

/** Ключ вместе с секретом. Секрет существует только здесь и только один раз. */
export interface IssuedCredential {
  readonly credentialId: MachineKeyId;
  readonly keyId: string;
  readonly secret: string;
  readonly expiresAt: Date | null;
}

export interface IssueInput {
  readonly kind: MachineKeyKind;
  readonly ownerId: string | null;
  readonly label: string;
  readonly allowedIps: readonly string[];
  readonly actorUserId: Id<'user'>;
  readonly actorRole: UserRole;
}

@Injectable()
export class MachineService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: MachineRepository,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('machine-access');
  }

  /**
   * Проверяет предъявленный ключ.
   *
   * Наружу все отказы выглядят одинаково: по разнице ответов иначе выясняется, какой
   * идентификатор существует и с какого адреса ключ принимается. Настоящая причина
   * уходит в лог — там её и читает тот, кто разбирает отказ узла.
   */
  async authenticate(presented: PresentedKey, ip: string | undefined): Promise<MachinePrincipal> {
    const now = new Date();
    const row = await this.repository.findByKeyId(presented.keyId);
    const presentedHash = hashSecret(presented.secret);

    if (row === undefined) {
      // Сравнение выполняется всё равно: отсутствие ключа должно занимать столько же,
      // сколько неверный секрет.
      secretHashEquals(ABSENT_KEY_HASH, presentedHash);
      this.reject(presented.keyId, 'ключ не найден', ip);
    }

    if (!secretHashEquals(row.secretHash, presentedHash)) {
      this.reject(presented.keyId, 'секрет не совпал', ip);
    }
    if (row.revokedAt !== null) {
      this.reject(presented.keyId, 'ключ отозван', ip);
    }
    if (row.expiresAt !== null && row.expiresAt <= now) {
      this.reject(presented.keyId, 'срок ключа истёк', ip);
    }
    if (!ipAllowed(row.allowedIps, ip)) {
      this.reject(presented.keyId, 'адрес не в списке разрешённых', ip);
    }
    if (row.kind === 'enrollment') {
      // Одноразовый токен установки — не учётные данные для работы: он обменивается
      // на постоянный ключ отдельным обработчиком и больше ни на что не годится.
      this.reject(presented.keyId, 'токен установки предъявлен как рабочий ключ', ip);
    }

    if (
      row.lastUsedAt === null ||
      now.getTime() - row.lastUsedAt.getTime() > LAST_USED_REFRESH_MS
    ) {
      await this.repository.touch(row.id, now);
    }

    return {
      credentialId: row.id,
      keyId: row.keyId,
      kind: row.kind,
      ownerId: row.ownerId,
    };
  }

  /**
   * Применяет одноразовый токен установки.
   *
   * Отметка ставится условным обновлением, а не проверкой перед записью: два одновременных
   * запуска скрипта иначе оба прошли бы проверку, и «одноразовый» стал бы словом.
   */
  async consumeEnrollment(presented: PresentedKey, ip: string | undefined): Promise<MachineKeyRow> {
    const now = new Date();
    const row = await this.repository.findByKeyId(presented.keyId);
    const presentedHash = hashSecret(presented.secret);

    if (row === undefined) {
      secretHashEquals(ABSENT_KEY_HASH, presentedHash);
      this.reject(presented.keyId, 'токен установки не найден', ip);
    }
    if (!secretHashEquals(row.secretHash, presentedHash)) {
      this.reject(presented.keyId, 'секрет токена установки не совпал', ip);
    }
    if (row.kind !== 'enrollment') {
      this.reject(presented.keyId, 'предъявлен не токен установки', ip);
    }
    if (row.revokedAt !== null) {
      this.reject(presented.keyId, 'токен установки отозван', ip);
    }
    if (row.expiresAt !== null && row.expiresAt <= now) {
      this.reject(presented.keyId, 'срок токена установки истёк', ip);
    }

    const consumed = await this.repository.consumeEnrollment(row.id, now);
    if (consumed === undefined) {
      // Повторное применение — не досадная случайность, а признак того, что команду
      // установки прочитал кто-то ещё. Поэтому запись в журнал, а не только отказ.
      await this.audit.record({
        action: 'machine_key.enrollment_reused',
        entityType: 'machine_credential',
        entityId: row.id,
        ip: ip ?? null,
        after: { key_id: row.keyId },
      });
      throw conflict('Токен установки уже применён');
    }

    await this.audit.record({
      action: 'machine_key.enrollment_consumed',
      entityType: 'machine_credential',
      entityId: row.id,
      ip: ip ?? null,
      after: { key_id: row.keyId },
    });

    return consumed;
  }

  /** Выпускает ключ. Секрет возвращается один раз и больше нигде не хранится. */
  async issue(input: IssueInput): Promise<IssuedCredential> {
    const issued: IssuedKey = issueKey(input.kind);
    const row = await this.repository.insert({
      kind: input.kind,
      keyId: issued.keyId,
      secretHash: issued.secretHash,
      ownerId: input.ownerId,
      label: input.label,
      allowedIps: [...input.allowedIps],
      expiresAt: expiryFor(input.kind),
      createdByUserId: input.actorUserId,
    });

    await this.audit.record({
      action: 'machine_key.issued',
      entityType: 'machine_credential',
      entityId: row.id,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      // Секрета здесь нет и быть не должно: журнал читают люди, которым он не нужен.
      after: {
        key_id: row.keyId,
        kind: row.kind,
        owner_id: row.ownerId,
        allowed_ips: row.allowedIps,
        expires_at: row.expiresAt?.toISOString() ?? null,
      },
    });

    return {
      credentialId: row.id,
      keyId: row.keyId,
      secret: issued.secret,
      expiresAt: row.expiresAt,
    };
  }

  async revoke(id: MachineKeyId, actorUserId: Id<'user'>, actorRole: UserRole): Promise<void> {
    const existing = await this.repository.findById(id);
    if (existing === undefined) {
      throw notFound('Ключ не найден');
    }

    const revoked = await this.repository.revoke(id, new Date());
    if (revoked === undefined) {
      // Уже отозван. Важен первый момент отзыва, поэтому он не переписывается,
      // но и ошибкой это не является: результат ровно тот, которого добивались.
      return;
    }

    await this.audit.record({
      action: 'machine_key.revoked',
      entityType: 'machine_credential',
      entityId: id,
      actorUserId,
      actorRole,
      before: { revoked_at: null },
      after: { key_id: revoked.keyId, revoked_at: revoked.revokedAt?.toISOString() ?? null },
    });
  }

  async listByKind(kind: MachineKeyKind): Promise<MachineKeyRow[]> {
    return this.repository.listByKind(kind);
  }

  /**
   * Единая точка отказа: одинаковый ответ наружу, точная причина в лог.
   *
   * Возвращаемый тип `never` нужен, чтобы после вызова компилятор считал недостижимым
   * всё, что идёт дальше, — иначе проверка на `undefined` не сужала бы тип.
   */
  private reject(keyId: string, reason: string, ip: string | undefined): never {
    this.logger.warn('Машинный ключ не принят', { key_id: keyId, reason, ip: ip ?? null });
    throw unauthenticated('Ключ не принят');
  }
}

function expiryFor(kind: MachineKeyKind): Date | null {
  const now = Date.now();
  switch (kind) {
    case 'enrollment':
      return new Date(now + ENROLLMENT_TTL_MS);
    case 'client_api':
      return new Date(now + CLIENT_KEY_TTL_MS);
    case 'node':
      // Срока нет намеренно: истёкший ключ узла означает отказ телефонии, а это худший
      // отказ, чем неотозванный ключ у машины, чей адрес в списке (ADR-0019).
      return null;
  }
}
