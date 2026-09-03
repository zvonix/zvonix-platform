/**
 * Очередь писем ([ADR-0029](../../../../../docs/adr/0029-pochta.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { toDatabaseError, type Database } from '@zvonix/db';
import { outboxMessages } from '@zvonix/db/schema';
import { newId, type Id } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type OutboxMessageId = Id<'outboxMessage'>;
export type OutboxMessageRow = typeof outboxMessages.$inferSelect;

/** Исполнитель запроса: пул или транзакция. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
export class MailRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Пул: нужен службе, чтобы открыть транзакцию вокруг отбора и отправки. */
  get db(): Database {
    return this.database.db;
  }

  /**
   * Кладёт письмо в очередь.
   *
   * `executor` передаётся тем, кто пишет письмо **вместе с событием**: токен
   * восстановления и письмо про него обязаны появиться одной транзакцией, иначе
   * возможны «токен есть, письма нет» и «письмо ушло, токена нет».
   */
  async enqueue(
    draft: { recipient: string; subject: string; body: string; kind: string },
    executor: Executor = this.db,
  ): Promise<OutboxMessageRow> {
    try {
      const [row] = await executor
        .insert(outboxMessages)
        .values({ id: newId<'outboxMessage'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Забирает письма, которым пора уходить.
   *
   * `for update skip locked`: два экземпляра воркера берут разные строки и не отправляют
   * одно письмо дважды. Без этого пришлось бы выбирать между «письмо продублировано»
   * и «воркер в одном экземпляре».
   */
  async claimDue(
    now: Date,
    limit: number,
    executor: Executor = this.db,
  ): Promise<OutboxMessageRow[]> {
    return executor
      .select()
      .from(outboxMessages)
      .where(and(eq(outboxMessages.status, 'pending'), lte(outboxMessages.sendAfter, now)))
      .orderBy(asc(outboxMessages.sendAfter))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  async markSent(id: OutboxMessageId, at: Date, executor: Executor = this.db): Promise<void> {
    await executor
      .update(outboxMessages)
      .set({ status: 'sent', sentAt: at, lastError: null, updatedAt: at })
      .where(eq(outboxMessages.id, id));
  }

  /**
   * Отмечает неудачу.
   *
   * Пока попытки не кончились — письмо остаётся в очереди с отодвинутым сроком;
   * когда кончились — помечается неотправленным **с текстом ошибки**: без него
   * «не отправилось» неотличимо от «не пробовали».
   */
  async markFailure(
    id: OutboxMessageId,
    input: { error: string; retryAt: Date | null; at: Date },
    executor: Executor = this.db,
  ): Promise<void> {
    await executor
      .update(outboxMessages)
      .set({
        status: input.retryAt === null ? 'failed' : 'pending',
        attempts: sql`${outboxMessages.attempts} + 1`,
        lastError: input.error.slice(0, 1000),
        ...(input.retryAt === null ? {} : { sendAfter: input.retryAt }),
        updatedAt: input.at,
      })
      .where(eq(outboxMessages.id, id));
  }

  /** Сколько писем ждёт отправки: по этому числу видно, что почта сломалась. */
  async countPending(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(outboxMessages)
      .where(eq(outboxMessages.status, 'pending'));
    return row?.count ?? 0;
  }

  /**
   * Убирает отправленные письма старше срока.
   *
   * Тело письма содержит одноразовый токен: хранить его дольше, чем нужно для разбора
   * «дошло ли письмо», незачем.
   */
  async deleteSentBefore(before: Date): Promise<number> {
    const removed = await this.db
      .delete(outboxMessages)
      .where(and(eq(outboxMessages.status, 'sent'), lte(outboxMessages.sentAt, before)))
      .returning({ id: outboxMessages.id });
    return removed.length;
  }
}
