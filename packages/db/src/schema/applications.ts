/**
 * Заявки на кабинет клиента или партнёра
 * ([ADR-0052](../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 *
 * Заявка — не карточка: карточку клиента или партнёра заводит одобрение, одной
 * транзакцией с переводом заявки в `approved`. До решения администратора человек
 * площадке не участник и звонить или принимать звонки не может.
 */

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  APPLICATION_STATUSES,
  CABINETS,
  type ApplicationStatus,
  type Cabinet,
} from '@zvonix/shared';
import { createdAt, idRef, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { users } from './users.js';

export const applications = pgTable(
  'applications',
  {
    id: primaryId<'application'>(),

    /** Кто подаёт. Учётная запись переживает отказ: вторая попытка — новая заявка. */
    userId: idRef<'user'>()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /** На какой кабинет. */
    kind: text().$type<Cabinet>().notNull(),

    status: text().$type<ApplicationStatus>().notNull().default('submitted'),

    /**
     * Анкета. Схема своя у каждого вида кабинета и общая с кабинетом (zod в
     * `@zvonix/shared`): проверяется при подаче, здесь хранится как есть.
     */
    answers: jsonb().notNull(),

    /** Кто решил. Пусто, пока заявка ждёт или отозвана заявителем. */
    decidedByUserId: idRef<'user'>().references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamptz(),

    /** Причина отказа — уходит заявителю письмом. */
    decisionNote: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('applications_kind_check', oneOf(t.kind, CABINETS)),
    check('applications_status_check', oneOf(t.status, APPLICATION_STATUSES)),
    // Решение и его момент — вместе: одобренная заявка без времени решения
    // не объяснила бы, когда появилась карточка.
    check(
      'applications_decided_matches_status',
      sql`(${t.status} in ('approved', 'rejected')) = (${t.decidedAt} is not null)`,
    ),
    // Одна открытая заявка на вид кабинета: вторая дублировала бы первую в очереди
    // администратора, и одобрение обеих завело бы две карточки.
    uniqueIndex('applications_open_key')
      .on(t.userId, t.kind)
      .where(sql`${t.status} = 'submitted'`),
    index('applications_status_created_idx').on(t.status, t.createdAt),
  ],
);
