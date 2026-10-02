/**
 * Платежи: хранение заявок ([ADR-0064](../../../../../docs/adr/0064-platezhi-karkas.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import { toDatabaseError, type Database, type Executor } from '@zvonix/db';
import { payments } from '@zvonix/db/schema';
import {
  newId,
  type Id,
  type MoneyAmount,
  type PaymentProviderId,
  type PaymentStatus,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type PaymentRow = typeof payments.$inferSelect;

export interface PaymentFilter {
  readonly status?: PaymentStatus;
  readonly clientId?: Id<'client'>;
  readonly limit: number;
  readonly offset: number;
}

@Injectable()
export class PaymentsRepository {
  constructor(private readonly database: DatabaseService) {}

  get db(): Database {
    return this.database.db;
  }

  async insert(draft: {
    clientId: Id<'client'>;
    provider: PaymentProviderId;
    amount: MoneyAmount;
    comment: string | null;
    createdByUserId: Id<'user'>;
  }): Promise<PaymentRow> {
    try {
      const [row] = await this.db
        .insert(payments)
        .values({ id: newId<'payment'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findById(id: Id<'payment'>, executor: Executor = this.db): Promise<PaymentRow | undefined> {
    const [row] = await executor.select().from(payments).where(eq(payments.id, id));
    return row;
  }

  async countPending(clientId: Id<'client'>): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(payments)
      .where(and(eq(payments.clientId, clientId), eq(payments.status, 'pending')));
    return row?.value ?? 0;
  }

  async list(filter: PaymentFilter): Promise<{ rows: PaymentRow[]; total: number }> {
    const parts: SQL[] = [];
    if (filter.status !== undefined) parts.push(eq(payments.status, filter.status));
    if (filter.clientId !== undefined) parts.push(eq(payments.clientId, filter.clientId));
    const where = parts.length === 0 ? undefined : and(...parts);

    const rows = await this.db
      .select()
      .from(payments)
      .where(where)
      .orderBy(desc(payments.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
    const [total] = await this.db.select({ value: count() }).from(payments).where(where);
    return { rows, total: total?.value ?? 0 };
  }

  /**
   * Переводит платёж из `pending` в окончательное состояние — **условным обновлением**.
   *
   * Два решения одновременно (подтвердил администратор, отозвал клиент) не должны оба
   * сработать: выигрывает первое, второе получает `undefined` и сообщает об этом.
   */
  async resolve(
    id: Id<'payment'>,
    patch: {
      status: Exclude<PaymentStatus, 'pending'>;
      receivedAmount?: MoneyAmount;
      resolutionNote?: string;
      resolvedByUserId: Id<'user'> | null;
    },
    executor: Executor = this.db,
  ): Promise<PaymentRow | undefined> {
    const [row] = await executor
      .update(payments)
      .set({
        status: patch.status,
        receivedAmount: patch.receivedAmount ?? null,
        resolutionNote: patch.resolutionNote ?? null,
        resolvedByUserId: patch.resolvedByUserId,
        resolvedAt: new Date(),
      })
      .where(and(eq(payments.id, id), eq(payments.status, 'pending')))
      .returning();
    return row;
  }
}
