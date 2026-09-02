/**
 * Запросы к резервам средств (ADR-0010).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { toDatabaseError } from '@zvonix/db';
import { reservations } from '@zvonix/db/schema';
import { newId, type Id, type MoneyAmount, type ReservationStatus } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';
import type { Executor } from './billing.repository.js';

export type ReservationId = Id<'reservation'>;
export type ReservationRow = typeof reservations.$inferSelect;

@Injectable()
export class ReservationRepository {
  constructor(private readonly database: DatabaseService) {}

  get db() {
    return this.database.db;
  }

  /**
   * Сумма действующих резервов клиента.
   *
   * Читается **внутри той же транзакции**, что и проверка остатка, и после блокировки
   * счёта: иначе сто одновременных вызовов все увидят нулевую сумму резервов, все
   * пройдут проверку и все состоятся.
   */
  async heldTotal(clientId: Id<'client'>, executor: Executor): Promise<bigint> {
    const result = await executor.execute<{ total: string }>(sql`
      select coalesce(sum(amount), 0) as total
        from reservations
       where client_id = ${clientId} and status = 'held'
    `);
    const row = result.rows[0];
    return row === undefined ? 0n : BigInt(row.total);
  }

  async insert(
    draft: {
      callId: Id<'call'>;
      clientId: Id<'client'>;
      amount: MoneyAmount;
      expiresAt: Date;
    },
    executor: Executor,
  ): Promise<ReservationRow> {
    try {
      const [row] = await executor
        .insert(reservations)
        .values({ id: newId<'reservation'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findByCall(callId: Id<'call'>): Promise<ReservationRow | undefined> {
    const [row] = await this.db.select().from(reservations).where(eq(reservations.callId, callId));
    return row;
  }

  /**
   * Закрывает резерв — **условным обновлением** по состоянию `held`.
   *
   * `undefined` означает, что резерв уже закрыт. Проверять отдельным чтением нельзя:
   * пришедший CDR и фоновое освобождение по сроку могут сойтись на одном резерве,
   * и оба увидят его действующим.
   */
  async settle(
    id: ReservationId,
    status: Exclude<ReservationStatus, 'held'>,
    at: Date,
    executor: Executor,
  ): Promise<ReservationRow | undefined> {
    const [row] = await executor
      .update(reservations)
      .set({ status, settledAt: at })
      .where(and(eq(reservations.id, id), eq(reservations.status, 'held')))
      .returning();
    return row;
  }

  /** Просроченные резервы: потерянный CDR не должен замораживать остаток навсегда. */
  async findExpired(deadline: Date, limit: number): Promise<ReservationRow[]> {
    return this.db
      .select()
      .from(reservations)
      .where(and(eq(reservations.status, 'held'), lte(reservations.expiresAt, deadline)))
      .orderBy(asc(reservations.expiresAt))
      .limit(limit);
  }
}
