/**
 * Запросы к ключам машинного доступа (ADR-0019).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { toDatabaseError, type Database } from '@zvonix/db';
import { machineCredentials } from '@zvonix/db/schema';
import { newId, type Id, type MachineKeyKind } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type MachineKeyId = Id<'machineCredential'>;
export type MachineKeyRow = typeof machineCredentials.$inferSelect;

@Injectable()
export class MachineRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db(): Database {
    return this.database.db;
  }

  /**
   * Поиск по публичной части. Горячий путь: выполняется на каждый запрос маршрута,
   * поэтому идёт по уникальному индексу, а не перебором с проверкой каждого секрета.
   */
  async findByKeyId(keyId: string): Promise<MachineKeyRow | undefined> {
    const [row] = await this.db
      .select()
      .from(machineCredentials)
      .where(eq(machineCredentials.keyId, keyId));
    return row;
  }

  async insert(draft: {
    kind: MachineKeyKind;
    keyId: string;
    secretHash: string;
    ownerId: string | null;
    label: string;
    allowedIps: string[];
    expiresAt: Date | null;
    createdByUserId: Id<'user'> | null;
  }): Promise<MachineKeyRow> {
    try {
      const [row] = await this.db
        .insert(machineCredentials)
        .values({ id: newId<'machineCredential'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /** Отметка о последнем применении. Ошибка здесь не должна ронять звонок. */
  async touch(id: MachineKeyId, now: Date): Promise<void> {
    await this.db
      .update(machineCredentials)
      .set({ lastUsedAt: now })
      .where(eq(machineCredentials.id, id));
  }

  /**
   * Помечает одноразовый токен применённым — **условным обновлением**.
   *
   * `undefined` означает, что токен уже применяли. Проверять отдельным чтением нельзя:
   * два одновременных запуска скрипта установки оба увидели бы «не применён»,
   * и одноразовость превратилась бы в её видимость.
   */
  async consumeEnrollment(id: MachineKeyId, now: Date): Promise<MachineKeyRow | undefined> {
    const [row] = await this.db
      .update(machineCredentials)
      .set({ usedAt: now })
      .where(and(eq(machineCredentials.id, id), isNull(machineCredentials.usedAt)))
      .returning();
    return row;
  }

  /** Отзыв пометкой. Повторный отзыв не меняет момента: важен первый. */
  async revoke(id: MachineKeyId, now: Date): Promise<MachineKeyRow | undefined> {
    const [row] = await this.db
      .update(machineCredentials)
      .set({ revokedAt: now })
      .where(and(eq(machineCredentials.id, id), isNull(machineCredentials.revokedAt)))
      .returning();
    return row;
  }

  async findById(id: MachineKeyId): Promise<MachineKeyRow | undefined> {
    const [row] = await this.db
      .select()
      .from(machineCredentials)
      .where(eq(machineCredentials.id, id));
    return row;
  }

  /** Ключи владельца, свежие сверху: по этому списку выполняется ротация. */
  async listByOwner(kind: MachineKeyKind, ownerId: string): Promise<MachineKeyRow[]> {
    return this.db
      .select()
      .from(machineCredentials)
      .where(and(eq(machineCredentials.kind, kind), eq(machineCredentials.ownerId, ownerId)))
      .orderBy(sql`${machineCredentials.createdAt} desc`);
  }

  /** Все ключи вида — для панели администратора. */
  async listByKind(kind: MachineKeyKind): Promise<MachineKeyRow[]> {
    return this.db
      .select()
      .from(machineCredentials)
      .where(eq(machineCredentials.kind, kind))
      .orderBy(asc(machineCredentials.label));
  }
}
