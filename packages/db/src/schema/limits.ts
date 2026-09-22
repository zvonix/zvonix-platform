/**
 * Лимиты по окнам ([ADR-0026](../../../docs/adr/0026-limity-po-oknam.md)).
 *
 * Это в первую очередь **защита SIM партнёра**, и только во вторую — ограничение клиента:
 * оператор блокирует SIM за нечеловеческий профиль трафика, а потерянная SIM означает
 * потерянного партнёра (BACKLOG.md).
 *
 * Счётчик живёт здесь, а не в кэше: месячная квота минут, потерянная при перезапуске
 * Redis, — это не «сброс кэша», а молча снятая защита. Инкремент выполняется той же
 * транзакцией, что создаёт вызов, поэтому «вызов есть» и «счётчик вырос» не расходятся
 * ни в одну сторону.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { LIMIT_METRICS, LIMIT_WINDOWS, type LimitMetric, type LimitWindow } from '@zvonix/shared';
import { createdAt, idRef, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { clients, partners } from './billing.js';
import { channels, simCards } from './telephony.js';

/**
 * Одно ограничение: сколько чего можно субъекту за окно.
 *
 * Отдельной сущности «политика» нет: у неё не было бы ни одного собственного атрибута,
 * кроме владельца, а владелец есть в каждой строке. «Политика» — это просто набор строк
 * у субъекта (ADR-0026).
 *
 * Владелец — четыре колонки, из которых заполнена ровно одна. Полиморфная пара «тип
 * плюс идентификатор» лишила бы ссылку целостности и каскадного удаления: лимит
 * удалённого канала иначе остался бы висеть и продолжил считаться.
 */
export const limitRules = pgTable(
  'limit_rules',
  {
    id: primaryId<'limitRule'>(),

    clientId: idRef<'client'>().references(() => clients.id, { onDelete: 'cascade' }),
    channelId: idRef<'channel'>().references(() => channels.id, { onDelete: 'cascade' }),
    partnerId: idRef<'partner'>().references(() => partners.id, { onDelete: 'cascade' }),
    simCardId: idRef<'simCard'>().references(() => simCards.id, { onDelete: 'cascade' }),

    window: text().$type<LimitWindow>().notNull(),
    metric: text().$type<LimitMetric>().notNull(),

    /** Предел в единицах метрики: звонков или минут. В счётчике минуты копятся секундами. */
    value: integer().notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('limit_rules_window_check', oneOf(t.window, LIMIT_WINDOWS)),
    check('limit_rules_metric_check', oneOf(t.metric, LIMIT_METRICS)),
    // Ноль означал бы «звонить нельзя вовсе», а это выражается состоянием субъекта,
    // а не лимитом: отключённый канал видно, а лимит в ноль выглядит как поломка.
    check('limit_rules_value_positive', sql`${t.value} > 0`),
    check(
      'limit_rules_single_subject',
      sql`(${t.clientId} is not null)::int + (${t.channelId} is not null)::int + (${t.partnerId} is not null)::int + (${t.simCardId} is not null)::int = 1`,
    ),
    // Два одинаковых окна с одной метрикой у одного субъекта означали бы, что предел
    // зависит от того, какую строку прочитали первой.
    unique('limit_rules_subject_key')
      .on(t.clientId, t.channelId, t.partnerId, t.simCardId, t.window, t.metric)
      .nullsNotDistinct(),
    // Горячий путь: все лимиты субъекта одним чтением.
    index('limit_rules_client_idx').on(t.clientId),
    index('limit_rules_channel_idx').on(t.channelId),
    index('limit_rules_partner_idx').on(t.partnerId),
    index('limit_rules_sim_idx').on(t.simCardId),
  ],
);

/**
 * Израсходованное за конкретное окно.
 *
 * Ключ — правило и начало окна. Начало вычисляется чистой функцией `bucketStart`
 * в UTC: одно и то же значение при проверке и при инкременте, иначе счётчик писался бы
 * в одно окно, а читался из другого.
 *
 * Старые окна не нужны никому, кроме разбора, и убираются фоновой задачей по сроку
 * ([ADR-0020](../../../docs/adr/0020-fonovye-zadachi.md)).
 */
export const limitCounters = pgTable(
  'limit_counters',
  {
    id: primaryId<'limitCounter'>(),

    limitRuleId: idRef<'limitRule'>()
      .notNull()
      // Правила нет — считать нечего.
      .references(() => limitRules.id, { onDelete: 'cascade' }),

    /** Начало окна в UTC. */
    bucketStart: timestamptz().notNull(),

    /** Звонки — штуками, минуты — секундами: разговор в 90 секунд не «полторы минуты». */
    amount: bigint({ mode: 'number' }).notNull().default(0),

    updatedAt: updatedAt(),
  },
  (t) => [
    check('limit_counters_amount_non_negative', sql`${t.amount} >= 0`),
    unique('limit_counters_bucket_key').on(t.limitRuleId, t.bucketStart),
    // Уборка по сроку ходит по началу окна.
    index('limit_counters_bucket_idx').on(t.bucketStart),
  ],
);
