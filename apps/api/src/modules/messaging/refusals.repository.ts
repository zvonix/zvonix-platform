/**
 * Отклонённые при приёме ([ADR-0098](../../../../../docs/adr/0098-otklonyonnye-pri-priyome.md)): журнал без денег и текста.
 */

import { Injectable } from '@nestjs/common';
import { and, count, eq, gte, inArray, lt } from 'drizzle-orm';
import { messageRefusals } from '@zvonix/db/schema';
import { newId, type Id, type MessageChannel, type MessageRefusalReason } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type MessageRefusalRow = typeof messageRefusals.$inferSelect;

@Injectable()
export class RefusalsRepository {
  constructor(private readonly database: DatabaseService) {}

  async insert(refusal: {
    clientId: Id<'client'>;
    channel: MessageChannel;
    recipient: string;
    reason: MessageRefusalReason;
  }): Promise<void> {
    await this.database.db
      .insert(messageRefusals)
      .values({ id: newId<'messageRefusal'>(), ...refusal });
  }

  async findByIds(ids: readonly string[]): Promise<MessageRefusalRow[]> {
    if (ids.length === 0) return [];
    return this.database.db
      .select()
      .from(messageRefusals)
      .where(inArray(messageRefusals.id, [...ids] as MessageRefusalRow['id'][]));
  }

  /** Сколько сообщений клиента отклонено при приёме с `since` — для строки «За 7 суток». */
  async countSince(clientId: Id<'client'>, since: Date): Promise<number> {
    const [row] = await this.database.db
      .select({ n: count() })
      .from(messageRefusals)
      .where(and(eq(messageRefusals.clientId, clientId), gte(messageRefusals.createdAt, since)));
    return row?.n ?? 0;
  }

  /** Стирает строки старше срока (номер — персональные данные); возвращает, сколько. */
  async purge(before: Date): Promise<number> {
    const removed = await this.database.db
      .delete(messageRefusals)
      .where(lt(messageRefusals.createdAt, before))
      .returning({ id: messageRefusals.id });
    return removed.length;
  }
}
