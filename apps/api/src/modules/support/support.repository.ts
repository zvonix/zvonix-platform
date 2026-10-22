/**
 * Обращения в поддержку: хранение
 * ([ADR-0085](../../../../../docs/adr/0085-obrashcheniya-v-podderzhku.md)).
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { containsIgnoringCase, toDatabaseError, type Database } from '@zvonix/db';
import { supportAttachments, supportTicketMessages, supportTickets } from '@zvonix/db/schema';
import {
  newId,
  type Id,
  type TicketCabinet,
  type TicketImageType,
  type TicketCategory,
  type TicketSide,
  TICKET_SCOPE_STATUSES,
  type TicketScope,
  type TicketStatus,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type TicketRow = typeof supportTickets.$inferSelect;
export type TicketMessageRow = typeof supportTicketMessages.$inferSelect;
export type AttachmentRow = typeof supportAttachments.$inferSelect;

export interface TicketFilter {
  readonly authorUserId?: Id<'user'>;
  readonly status?: TicketStatus;
  readonly scope?: TicketScope;
  readonly cabinet?: TicketCabinet;
  readonly category?: TicketCategory;
  /** Только обращения без исполнителя либо взятые этим сотрудником. */
  readonly unassigned?: boolean;
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
}

/** Состояния, в которых обращение ещё открыто. */
const OPEN_STATUSES = TICKET_SCOPE_STATUSES.active;

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
    attachmentIds?: readonly Id<'supportAttachment'>[];
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
        const messageId = newId<'supportTicketMessage'>();
        await tx.insert(supportTicketMessages).values({
          id: messageId,
          ticketId: ticket.id,
          authorUserId: draft.authorUserId,
          side: 'user',
          body: draft.body,
        });
        await this.link(tx, messageId, draft.authorUserId, draft.attachmentIds);
        return ticket;
      });
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /** Прикрепляет загруженные этим же человеком и ещё свободные картинки к сообщению (внутри той же транзакции). */
  private async link(
    tx: Pick<Database, 'update'>,
    messageId: Id<'supportTicketMessage'>,
    uploader: Id<'user'>,
    ids: readonly Id<'supportAttachment'>[] | undefined,
  ): Promise<void> {
    if (ids === undefined || ids.length === 0) return;
    await tx
      .update(supportAttachments)
      .set({ messageId })
      .where(
        and(
          inArray(supportAttachments.id, [...ids]),
          eq(supportAttachments.uploaderUserId, uploader),
          isNull(supportAttachments.messageId),
        ),
      );
  }

  async addAttachment(draft: {
    uploaderUserId: Id<'user'>;
    storedName: string;
    originalName: string;
    contentType: TicketImageType;
    size: number;
  }): Promise<AttachmentRow> {
    const [row] = await this.db
      .insert(supportAttachments)
      .values({ id: newId<'supportAttachment'>(), ...draft })
      .returning();
    if (row === undefined) throw new Error('Вставка не вернула строку');
    return row;
  }

  /** Сколько байт картинок загрузил человек с `since`: суточный предел. */
  async uploadedBytesSince(uploader: Id<'user'>, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${supportAttachments.size}), 0)::float8` })
      .from(supportAttachments)
      .where(
        and(
          eq(supportAttachments.uploaderUserId, uploader),
          gte(supportAttachments.createdAt, since),
        ),
      );
    return row?.total ?? 0;
  }

  /** Свободные (ни к чему не прикреплённые) картинки этого загрузившего среди названных. */
  freeAttachments(
    uploader: Id<'user'>,
    ids: readonly Id<'supportAttachment'>[],
  ): Promise<AttachmentRow[]> {
    return this.db
      .select()
      .from(supportAttachments)
      .where(
        and(
          inArray(supportAttachments.id, [...ids]),
          eq(supportAttachments.uploaderUserId, uploader),
          isNull(supportAttachments.messageId),
        ),
      );
  }

  /** Картинка вместе с обращением, к которому она прикреплена, и признаком заметки; `ticket` пуст, пока не прикреплена. */
  async attachmentWithContext(
    id: string,
  ): Promise<
    { attachment: AttachmentRow; ticket: TicketRow | undefined; internal: boolean } | undefined
  > {
    if (!/^[0-9a-f-]{36}$/u.test(id)) return undefined;
    const [row] = await this.db
      .select({
        attachment: supportAttachments,
        ticket: supportTickets,
        internal: supportTicketMessages.internal,
      })
      .from(supportAttachments)
      .leftJoin(supportTicketMessages, eq(supportTicketMessages.id, supportAttachments.messageId))
      .leftJoin(supportTickets, eq(supportTickets.id, supportTicketMessages.ticketId))
      .where(eq(supportAttachments.id, id as Id<'supportAttachment'>));
    if (row === undefined) return undefined;
    return {
      attachment: row.attachment,
      ticket: row.ticket ?? undefined,
      internal: row.internal ?? false,
    };
  }

  /** Картинки сообщений одним запросом, сгруппированные по сообщению. */
  async attachmentsOf(
    messageIds: readonly Id<'supportTicketMessage'>[],
  ): Promise<Map<string, AttachmentRow[]>> {
    const grouped = new Map<string, AttachmentRow[]>();
    if (messageIds.length === 0) return grouped;
    const rows = await this.db
      .select()
      .from(supportAttachments)
      .where(inArray(supportAttachments.messageId, [...messageIds]))
      .orderBy(asc(supportAttachments.createdAt));
    for (const row of rows) {
      if (row.messageId === null) continue;
      grouped.set(row.messageId, [...(grouped.get(row.messageId) ?? []), row]);
    }
    return grouped;
  }

  /** Стирает строки неприкреплённых картинок старше границы и возвращает их (файлы стирает сервис). */
  deleteUnlinkedBefore(before: Date): Promise<AttachmentRow[]> {
    return this.db
      .delete(supportAttachments)
      .where(and(isNull(supportAttachments.messageId), lt(supportAttachments.createdAt, before)))
      .returning();
  }

  async findById(id: Id<'supportTicket'>): Promise<TicketRow | undefined> {
    const [row] = await this.db.select().from(supportTickets).where(eq(supportTickets.id, id));
    return row;
  }

  async list(
    filter: TicketFilter,
  ): Promise<{ rows: TicketRow[]; total: number; counts: Record<TicketScope, number> }> {
    const where = this.conditions(filter);
    // Счётчики вкладок — по тем же отборам, но без вкладки и состояния: «Закрытые (3)» видно и с открытой вкладки.
    const { scope: _scope, status: _status, ...rest } = filter;
    const [rows, [total], byStatus] = await Promise.all([
      this.db
        .select()
        .from(supportTickets)
        .where(where)
        .orderBy(desc(supportTickets.lastMessageAt))
        .limit(filter.limit)
        .offset(filter.offset),
      this.db.select({ n: count() }).from(supportTickets).where(where),
      this.db
        .select({ status: supportTickets.status, n: count() })
        .from(supportTickets)
        .where(this.conditions(rest))
        .groupBy(supportTickets.status),
    ]);
    const counts: Record<TicketScope, number> = { active: 0, done: 0 };
    for (const row of byStatus) {
      if (TICKET_SCOPE_STATUSES.active.includes(row.status)) counts.active += row.n;
      else counts.done += row.n;
    }
    return { rows, total: total?.n ?? 0, counts };
  }

  private conditions(filter: TicketFilter): SQL | undefined {
    const parts: (SQL | undefined)[] = [];
    if (filter.authorUserId !== undefined) {
      parts.push(eq(supportTickets.authorUserId, filter.authorUserId));
    }
    if (filter.status !== undefined) parts.push(eq(supportTickets.status, filter.status));
    if (filter.scope !== undefined) {
      parts.push(inArray(supportTickets.status, [...TICKET_SCOPE_STATUSES[filter.scope]]));
    }
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
    attachmentIds?: readonly Id<'supportAttachment'>[];
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
        await this.link(tx, message.id, draft.authorUserId, draft.attachmentIds);
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

  /**
   * Закрывает обращения, на которые поддержка ответила или которые решены, а автор не вернулся с `before` (ADR-0089).
   * Возвращает закрытые: по каждому пишется запись в журнал.
   */
  async closeStaleBefore(before: Date, now: Date): Promise<Id<'supportTicket'>[]> {
    const closed = await this.db
      .update(supportTickets)
      .set({ status: 'closed', closedAt: now })
      .where(
        and(
          inArray(supportTickets.status, ['waiting_user', 'resolved']),
          lt(supportTickets.lastMessageAt, before),
        ),
      )
      .returning({ id: supportTickets.id });
    return closed.map((row) => row.id);
  }

  /** Автор открыл обращение: ответ поддержки прочитан. */
  async markRead(id: Id<'supportTicket'>, now: Date): Promise<void> {
    await this.db
      .update(supportTickets)
      .set({ authorReadAt: now })
      .where(eq(supportTickets.id, id));
  }

  /** Сколько обращений автора ждут его прочтения: поддержка ответила, автор ещё не открывал. */
  async countUnreadByAuthor(authorUserId: Id<'user'>): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.authorUserId, authorUserId),
          eq(supportTickets.status, 'waiting_user'),
          or(
            isNull(supportTickets.authorReadAt),
            lt(supportTickets.authorReadAt, supportTickets.lastMessageAt),
          ),
        ),
      );
    return row?.n ?? 0;
  }
}
