/**
 * Пороги автоматического отключения
 * ([ADR-0027](../../../docs/adr/0027-porog-otklyucheniya.md)).
 *
 * Порог считает **отказы сети**, а не ASR: доля отвеченных падает, когда клиент звонит
 * по холодной базе, и отключать за это SIM партнёра значит наказывать его за поведение
 * чужих абонентов.
 *
 * Окно скользящее, в отличие от квот: неисправность не знает о полуночи, и SIM, отказавшая
 * двадцать раз с 23:50 до 00:10, календарным окном не ловится вовсе.
 */

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { FAILURE_SCOPES, type FailureScope } from '@zvonix/shared';
import { createdAt, oneOf, primaryId, updatedAt } from '../columns.js';

export const failureThresholds = pgTable(
  'failure_thresholds',
  {
    id: primaryId<'failureThreshold'>(),

    /** Что отключается: SIM или шлюз. Канал автоматически не отключается (ADR-0027). */
    scope: text().$type<FailureScope>().notNull(),

    /** Сколько отказов сети подряд по окну означает неисправность. */
    failures: integer().notNull(),

    /** Длина скользящего окна в минутах. */
    windowMinutes: integer().notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('failure_thresholds_scope_check', oneOf(t.scope, FAILURE_SCOPES)),
    // Единица означала бы отключение с первого же отказа сети — а он случается
    // и на исправной SIM, когда абонент вне зоны.
    check('failure_thresholds_failures_min', sql`${t.failures} >= 2`),
    check('failure_thresholds_window_positive', sql`${t.windowMinutes} > 0`),
    // Один порог на область: два означали бы, что срабатывает тот, который прочитали
    // первым.
    uniqueIndex('failure_thresholds_scope_key').on(t.scope),
  ],
);
