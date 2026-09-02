/**
 * Запросы к вызовам (ADR-0010, DOMAIN.md).
 */

import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { toDatabaseError, type Database } from '@zvonix/db';
import { calls, simCards } from '@zvonix/db/schema';
import {
  newId,
  OPEN_CALL_STATUSES,
  type CallFailureReason,
  type CallStatus,
  type Id,
  type Msisdn,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type CallId = Id<'call'>;
export type CallRow = typeof calls.$inferSelect;

/** Исполнитель запроса: подключение либо открытая транзакция. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
export class CallRepository {
  constructor(private readonly database: DatabaseService) {}

  get db(): Database {
    return this.database.db;
  }

  async insert(
    draft: {
      externalId: string;
      channelId: Id<'channel'>;
      nodeId: Id<'node'>;
      destination: Msisdn;
      operatorId: Id<'operator'> | null;
      region: string | null;
      simCardId: Id<'simCard'> | null;
      gatewayId: Id<'gateway'> | null;
      status: CallStatus;
      failureReason: CallFailureReason | null;
    },
    executor: Executor = this.db,
  ): Promise<CallRow> {
    try {
      const [row] = await executor
        .insert(calls)
        .values({ id: newId<'call'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findByExternalId(externalId: string): Promise<CallRow | undefined> {
    const [row] = await this.db.select().from(calls).where(eq(calls.externalId, externalId));
    return row;
  }

  /**
   * Блокирует SIM до конца транзакции.
   *
   * Нужна перед счётом открытых вызовов: без блокировки два одновременных запроса
   * маршрута насчитают одно и то же число и оба решат, что место есть. Блокируется
   * именно SIM, потому что ограничение — на неё: очередь выстраивается только между
   * вызовами на одну карту и никого больше не задерживает.
   */
  async lockSim(simCardId: Id<'simCard'>, executor: Executor): Promise<boolean> {
    const rows = await executor
      .select({ id: simCards.id })
      .from(simCards)
      .where(eq(simCards.id, simCardId))
      .for('update');
    return rows.length === 1;
  }

  /** Сколько вызовов сейчас открыто на этой SIM. */
  async countOpenOnSim(simCardId: Id<'simCard'>, executor: Executor = this.db): Promise<number> {
    const result = await executor.execute<{ count: string }>(sql`
      select count(*)::text as count
        from calls
       where sim_card_id = ${simCardId}
         and status in ${sql.raw(`(${OPEN_CALL_STATUSES.map((value) => `'${value}'`).join(', ')})`)}
    `);
    const row = result.rows[0];
    return row === undefined ? 0 : Number.parseInt(row.count, 10);
  }

  async setStatus(
    id: CallId,
    status: CallStatus,
    patch: {
      failureReason?: CallFailureReason | null;
      answeredAt?: Date | null;
      endedAt?: Date | null;
      durationSeconds?: number | null;
    } = {},
  ): Promise<CallRow | undefined> {
    try {
      const [row] = await this.db
        .update(calls)
        .set({ status, ...patch })
        .where(eq(calls.id, id))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }
}
