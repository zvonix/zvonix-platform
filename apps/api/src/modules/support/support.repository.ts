/**
 * Обращения в поддержку: хранение
 * ([ADR-0085](../../../../../docs/adr/0085-obrashcheniya-v-podderzhku.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import { containsIgnoringCase, toDatabaseError, type Database } from '@zvonix/db';
import { supportTicketMessages, supportTickets } from '@zvonix/db/schema';
import {
  newId,
  type Id,
  type TicketCabinet,
  type TicketCategory,
  type TicketSide,
  type TicketStatus,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type TicketRow = typeof supportTickets.$inferSelect;
export type TicketMessageRow = typeof supportTicketMessages.$inferSelect;

export interface TicketFilter {
  readonly authorUserId?: Id<'user'>;
  readonly status?: TicketStatus;
  readonly cabinet?: TicketCabinet;
  readonly category?: TicketCategory;
  /** Только обращения без исполнителя либо взятые этим сотрудником. */
  readonly unassigned?: boolean;
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
}

/** Состояния, в которых обращение ещё открыто. */
const OPEN_STATUSES: readonly TicketStatus[] = ['open', 'in_progress', 'waiting_user'];

@Injectable()
export class SupportRepository {
  constructor(private readonly database: DatabaseService) {}

  get db(): Database {
    return this.database.db;
  }

  /** Новое обращение вместе с первой репликой: одной транзакцией, пустого обращения не бывает. */
  async createWithMessage(draft: {
    authorUserId: Id<'user'>;
    authorEmail: string;
    cabinet: TicketCabinet;
    subject: string;
    category: TicketCategory;
    body: string;
  }): Promise<TicketRow> {
    try {
      return await this.db.transaction(async (tx) => {
        const [ticket] = await tx
          .insert(supportTickets)
          .values({
            id: newId<'supportTicket'>(),
            authorUserId: draft.authorUserId,
            authorEmail: draft.authorEmail,
            cabinet: draft.cabinet,
            subject: draft.subject,
            category: draft.category,
          })
          .returning();
        if (ticket === undefined) throw new Error('Вставка не вернула строку');
        await tx.insert(supportTicketMessages).values({
          id: newId<'supportTicketMessage'>(),
          ticketId: ticket.id,
          authorUserId: draft.authorUserId,
          side: 'user',
          body: draft.body,
        });
        return ticket;
      });
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findById(id: Id<'supportTicket'>): Promise<TicketRow | undefined> {
    const [row] = await this.db.select().from(supportTickets).where(eq(supportTickets.id, id));
    return row;
  }

  async list(filter: TicketFilter): Promise<{ rows: TicketRow[]; total: number }> {
    const where = this.conditions(filter);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(supportTickets)
        .where(where)
        .orderBy(desc(supportTickets.lastMessageAt))
        .limit(filter.limit)
        .offset(filter.offset),
      this.db.select({ n: count() }).from(supportTickets).where(where),
    ]);
    return { rows, total: total?.n ?? 0 };
  }

  private conditions(filter: TicketFilter): SQL | undefined {
    const parts: (SQL | undefined)[] = [];
    if (filter.authorUserId !== undefined) {
      parts.push(eq(supportTickets.authorUserId, filter.authorUserId));
    }
    if (filter.status !== undefined) parts.push(eq(supportTickets.status, filter.status));
    if (filter.cabinet !== undefined) parts.push(eq(supportTickets.cabinet, filter.cabinet));
    if (filter.category !== undefined) parts.push(eq(supportTickets.category, filter.category));
    if (filter.unassigned === true) parts.push(isNull(supportTickets.assigneeUserId));
    if (filter.search !== undefined && filter.search !== '') {
      parts.push(
        or(
          containsIgnoringCase(supportTickets.subject, filter.search),
          containsIgnoringCase(supportTickets.authorEmail, filter.search),
        ),
      );
    }
    return and(...parts);
  }

  /** Сколько у автора открытых обращений. */
  async countOpenByAuthor(authorUserId: Id<'user'>): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.authorUserId, authorUserId),
          inArray(supportTickets.status, [...OPEN_STATUSES]),
        ),
      );
    return row?.n ?? 0;
  }

  /** Реплики по порядку; служебные заметки отдаются только сотрудникам. */
  async messages(
    ticketId: Id<'supportTicket'>,
    includeInternal: boolean,
  ): Promise<TicketMessageRow[]> {
    return this.db
      .select()
      .from(supportTicketMessages)
      .where(
        and(
          eq(supportTicketMessages.ticketId, ticketId),
          includeInternal ? undefined : eq(supportTicketMessages.internal, false),
        ),
      )
      .orderBy(asc(supportTicketMessages.createdAt), asc(supportTicketMessages.id));
  }

  /**
   * Реплика и вызванное ею движение статуса — одной транзакцией. Заметка статус и «последнюю реплику» не двигает:
   * её автор не видит, и очередь не должна думать, что кто-то ответил.
   */
  async addMessage(draft: {
    ticketId: Id<'supportTicket'>;
    authorUserId: Id<'user'>;
    side: TicketSide;
    body: string;
    internal: boolean;
    nextStatus: TicketStatus | undefined;
    now: Date;
  }): Promise<TicketMessageRow> {
    try {
      return await this.db.transaction(async (tx) => {
        const [message] = await tx
          .insert(supportTicketMessages)
          .values({
            id: newId<'supportTicketMessage'>(),
            ticketId: draft.ticketId,
            authorUserId: draft.authorUserId,
            side: draft.side,
            body: draft.body,
            internal: draft.internal,
          })
          .returning();
        if (message === undefined) throw new Error('Вставка не вернула строку');
        if (!draft.internal) {
          await tx
            .update(supportTickets)
            .set({
              lastMessageAt: draft.now,
              ...(draft.nextStatus === undefined
                ? {}
                : {
                    status: draft.nextStatus,
                    resolvedAt: draft.nextStatus === 'resolved' ? draft.now : null,
                  }),
            })
            .where(eq(supportTickets.id, draft.ticketId));
        }
        return message;
      });
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async setStatus(id: Id<'supportTicket'>, status: TicketStatus, now: Date): Promise<void> {
    await this.db
      .update(supportTickets)
      .set({
        status,
        resolvedAt: status === 'resolved' ? now : null,
        closedAt: status === 'closed' ? now : null,
      })
      .where(eq(supportTickets.id, id));
  }

  async setAssignee(id: Id<'supportTicket'>, assignee: Id<'user'> | null): Promise<void> {
    await this.db
      .update(supportTickets)
      .set({ assigneeUserId: assignee })
      .where(eq(supportTickets.id, id));
  }

  /** Закрывает решённые обращения, к которым не возвращались с `before`. Возвращает, сколько закрыто. */
  async closeResolvedBefore(before: Date, now: Date): Promise<number> {
    const closed = await this.db
      .update(supportTickets)
      .set({ status: 'closed', closedAt: now })
      .where(and(eq(supportTickets.status, 'resolved'), lt(supportTickets.lastMessageAt, before)))
      .returning({ id: supportTickets.id });
    return closed.length;
  }
}
