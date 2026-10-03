/**
 * Замеры состояния серверов: нагрузка, память, диск
 * ([ADR-0065](../../../../docs/adr/0065-sostoyanie-serverov-i-istoriya.md)).
 *
 * По строке на замер. Источник — узел (`node_id`) либо сама площадка (пусто). Всё целыми
 * числами: нагрузка в сотых долях, память и диск в мегабайтах. История живёт ограниченное
 * время (настройка `retention.metrics_days`) и убирается фоновой задачей.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable } from 'drizzle-orm/pg-core';
import { idRef, primaryId, timestamptz } from '../columns.js';
import { nodes } from './nodes.js';

export const serverMetrics = pgTable(
  'server_metrics',
  {
    id: primaryId<'serverMetric'>(),

    /** Чей замер. Пусто — сама площадка. Замеры уходят вместе с узлом. */
    nodeId: idRef<'node'>().references(() => nodes.id, { onDelete: 'cascade' }),

    takenAt: timestamptz().notNull(),

    /** Средняя нагрузка за минуту, в сотых: 1,25 хранится как 125. */
    load1Centi: integer().notNull(),

    /** Ядер процессора: нагрузка 2,00 на двух ядрах — полная, на восьми — четверть. */
    cpuCores: integer().notNull(),

    memTotalMb: integer().notNull(),
    memAvailableMb: integer().notNull(),
    diskTotalMb: integer().notNull(),
    diskFreeMb: integer().notNull(),

    /** Активных вызовов; пусто у площадки — вызовы ведёт узел. */
    activeCalls: integer(),
  },
  (t) => [
    index('server_metrics_source_time_idx').on(t.nodeId, t.takenAt),
    index('server_metrics_time_idx').on(t.takenAt),
    check(
      'server_metrics_non_negative',
      sql`${t.load1Centi} >= 0 and ${t.cpuCores} >= 1 and ${t.memTotalMb} >= 0 and ${t.memAvailableMb} >= 0 and ${t.diskTotalMb} >= 0 and ${t.diskFreeMb} >= 0`,
    ),
  ],
);
