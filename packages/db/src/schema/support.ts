/**
 * Обращения в поддержку ([ADR-0085](../../../../docs/adr/0085-obrashcheniya-v-podderzhku.md)).
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text } from 'drizzle-orm/pg-core';
import {
  TICKET_CABINETS,
  TICKET_CATEGORIES,
  TICKET_SIDES,
  TICKET_STATUSES,
  type TicketCabinet,
  type TicketCategory,
  type TicketSide,
  type TicketStatus,
} from '@zvonix/shared';
import { createdAt, idRef, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { users } from './users.js';

export const supportTickets = pgTable(
  'support_tickets',
  {
    id: primaryId<'supportTicket'>(),

    /** Автор. Обращение переживает удаление учётной записи как история разговора. */
    authorUserId: idRef<'user'>().references(() => users.id, { onDelete: 'set null' }),
    /** Адрес автора на момент обращения: сотрудник должен знать, кому отвечать, даже когда записи уже нет. */
    authorEmail: text().notNull(),
    cabinet: text().$type<TicketCabinet>().notNull(),

    subject: text().notNull(),
    category: text().$type<TicketCategory>().notNull(),
    status: text().$type<TicketStatus>().notNull().default('open'),

    /** Сотрудник, который взял обращение. */
    assigneeUserId: idRef<'user'>().references(() => users.id, { onDelete: 'set null' }),

    /** Последняя реплика: по ней очередь сортируется, а автоматическое закрытие отсчитывает срок. */
    lastMessageAt: timestamptz().notNull().defaultNow(),
    resolvedAt: timestamptz(),
    closedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('support_tickets_status_check', oneOf(t.status, TICKET_STATUSES)),
    check('support_tickets_category_check', oneOf(t.category, TICKET_CATEGORIES)),
    check('support_tickets_cabinet_check', oneOf(t.cabinet, TICKET_CABINETS)),
    index('support_tickets_author_idx').on(t.authorUserId, t.lastMessageAt),
    // Очередь сотрудников: по состоянию и давности последней реплики.
    index('support_tickets_queue_idx').on(t.status, t.lastMessageAt),
  ],
);

export const supportTicketMessages = pgTable(
  'support_ticket_messages',
  {
    id: primaryId<'supportTicketMessage'>(),
    ticketId: idRef<'supportTicket'>()
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    authorUserId: idRef<'user'>().references(() => users.id, { onDelete: 'set null' }),
    side: text().$type<TicketSide>().notNull(),

    body: text().notNull(),

    /** Заметка сотрудников: автору не показывается и письмом не уходит. */
    internal: boolean().notNull().default(false),

    createdAt: createdAt(),
  },
  (t) => [
    check('support_ticket_messages_side_check', oneOf(t.side, TICKET_SIDES)),
    // Внутренней может быть только реплика сотрудника.
    check('support_ticket_messages_internal_staff', sql`not ${t.internal} or ${t.side} = 'staff'`),
    index('support_ticket_messages_ticket_idx').on(t.ticketId, t.createdAt),
  ],
);
