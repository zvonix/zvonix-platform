/**
 * Какие письма получает владелец аккаунта ([ADR-0104](../../../docs/adr/0104-pisma-nastraivaet-sam-poluchatel.md)).
 *
 * Одна строка на учётную запись; строки нет — всё по умолчанию: письма включены, порог «мало денег» — площадки.
 * Переключатель площадки в настройках главнее: выключен — письмо этого вида не уходит никому.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, idRef, money, primaryId, updatedAt } from '../columns.js';
import { users } from './users.js';

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: primaryId<'notificationPreference'>(),
    userId: idRef<'user'>()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Клиенту: на счёте осталось мало (ADR-0060). */
    lowBalance: boolean().notNull().default(true),
    /** Свой порог «мало денег» в микроединицах; пусто — порог площадки. */
    lowBalanceThreshold: money(),
    /** Клиенту: решение по заявке на пополнение (ADR-0066). */
    paymentDecision: boolean().notNull().default(true),

    /** Партнёру: SIM или шлюз отключились автоматом из-за отказов сети (ADR-0066). */
    equipmentSuspended: boolean().notNull().default(true),
    /** Партнёру: SIM или шлюз почти не соединяют по вине сети (ADR-0103). */
    poorConnection: boolean().notNull().default(true),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('notification_preferences_user_key').on(t.userId),
    check(
      'notification_preferences_threshold_positive',
      sql`${t.lowBalanceThreshold} is null or ${t.lowBalanceThreshold} > 0`,
    ),
  ],
);
