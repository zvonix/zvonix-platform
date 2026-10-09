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
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import {
  LIMIT_METRICS,
  LIMIT_PERIOD_START_DAY_MAX,
  LIMIT_ROUNDINGS,
  LIMIT_SET_BY,
  LIMIT_WINDOWS,
  type LimitMetric,
  type LimitRounding,
  type LimitSetBy,
  type LimitWindow,
} from '@zvonix/shared';
import { createdAt, idRef, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { clients, partners } from './billing.js';
import { partnerTariffs } from './tariffs.js';
import { channels, simCards } from './telephony.js';

/**
 * Одно ограничение: сколько чего можно субъекту за окно.
 *
 * Отдельной сущности «политика» нет: у неё не было бы ни одного собственного атрибута,
 * кроме владельца, а владелец есть в каждой строке. «Политика» — это просто набор строк
 * у субъекта (ADR-0026).
 *
 * Владелец — пять колонок, из которых заполнена ровно одна. Полиморфная пара «тип
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

    /**
     * Лимит в тарифе партнёра ([ADR-0080](../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)):
     * действует на **каждую карту**, к которой применён тариф (SIM → шлюз → тариф по умолчанию),
     * счётчик у каждой карты свой, поэтому `per_sim` у такого правила всегда истина.
     */
    tariffId: idRef<'partnerTariff'>().references(() => partnerTariffs.id, { onDelete: 'cascade' }),

    window: text().$type<LimitWindow>().notNull(),
    metric: text().$type<LimitMetric>().notNull(),

    /** Предел в единицах метрики: звонков или минут. В счётчике минуты копятся секундами. */
    value: integer().notNull(),

    /**
     * Правило партнёра считается **у каждой его SIM отдельно** — одно правило, свой
     * счётчик у каждой карты ([ADR-0057](../../../docs/adr/0057-limity-partnyora.md)).
     * Карта, вставленная позже, защищена сразу. Только у правила партнёра.
     */
    perSim: boolean().notNull().default(false),

    /** Как разговор идёт в счётчик минут: посекундно или с округлением до минуты. */
    rounding: text().$type<LimitRounding>().notNull().default('second'),

    /** День обновления месячного окна (1–28); пусто — первое число. Только у `month`. */
    periodStartDay: smallint(),

    /** Кто задал: площадка или сам партнёр. Партнёр меняет только свои правила. */
    setBy: text().$type<LimitSetBy>().notNull().default('platform'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('limit_rules_window_check', oneOf(t.window, LIMIT_WINDOWS)),
    check('limit_rules_metric_check', oneOf(t.metric, LIMIT_METRICS)),
    // Ноль означал бы «звонить нельзя вовсе», а это выражается состоянием субъекта,
    // а не лимитом: отключённый канал видно, а лимит в ноль выглядит как поломка.
    check('limit_rules_value_positive', sql`${t.value} > 0`),
    check('limit_rules_rounding_check', oneOf(t.rounding, LIMIT_ROUNDINGS)),
    check('limit_rules_set_by_check', oneOf(t.setBy, LIMIT_SET_BY)),
    // Округлять звонки нечего; «на каждую карту» бывает только у правила партнёра;
    // день обновления — только у месячного окна.
    check('limit_rules_rounding_minutes', sql`${t.metric} = 'minutes' or ${t.rounding} = 'second'`),
    check(
      'limit_rules_per_sim_owner',
      sql`not ${t.perSim} or ${t.partnerId} is not null or ${t.tariffId} is not null`,
    ),
    // Лимит тарифа — всегда «на каждую карту»: общего счётчика у тарифа нет.
    check('limit_rules_tariff_per_sim', sql`${t.tariffId} is null or ${t.perSim}`),
    check(
      'limit_rules_period_start_day',
      sql`${t.periodStartDay} is null or (${t.window} = 'month' and ${t.periodStartDay} between 1 and ${sql.raw(String(LIMIT_PERIOD_START_DAY_MAX))})`,
    ),
    // Партнёр видит правила площадки, а своё задаёт рядом, не стирая чужого.
    check(
      'limit_rules_partner_sets_own',
      sql`${t.setBy} = 'platform' or ${t.partnerId} is not null or ${t.simCardId} is not null or ${t.tariffId} is not null`,
    ),
    check(
      'limit_rules_single_subject',
      sql`(${t.clientId} is not null)::int + (${t.channelId} is not null)::int + (${t.partnerId} is not null)::int + (${t.simCardId} is not null)::int + (${t.tariffId} is not null)::int = 1`,
    ),
    // Два одинаковых окна с одной метрикой у одного субъекта означали бы, что предел
    // зависит от того, какую строку прочитали первой.
    // «На каждую карту» и «всего по партнёру» — разные правила; площадка и партнёр —
    // тоже: оба предела действуют (ADR-0057).
    unique('limit_rules_subject_key')
      .on(
        t.clientId,
        t.channelId,
        t.partnerId,
        t.simCardId,
        t.tariffId,
        t.window,
        t.metric,
        t.perSim,
        t.setBy,
      )
      .nullsNotDistinct(),
    // Горячий путь: все лимиты субъекта одним чтением.
    index('limit_rules_client_idx').on(t.clientId),
    index('limit_rules_channel_idx').on(t.channelId),
    index('limit_rules_partner_idx').on(t.partnerId),
    index('limit_rules_sim_idx').on(t.simCardId),
    index('limit_rules_tariff_idx').on(t.tariffId),
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

    /**
     * SIM, чей это счётчик, — у правила «на каждую карту» (ADR-0057). У прочих пусто:
     * счётчик один на правило.
     */
    simCardId: idRef<'simCard'>().references(() => simCards.id, { onDelete: 'cascade' }),

    /** Начало окна в UTC. */
    bucketStart: timestamptz().notNull(),

    /** Звонки — штуками, минуты — секундами: разговор в 90 секунд не «полторы минуты». */
    amount: bigint({ mode: 'number' }).notNull().default(0),

    updatedAt: updatedAt(),
  },
  (t) => [
    check('limit_counters_amount_non_negative', sql`${t.amount} >= 0`),
    unique('limit_counters_bucket_key')
      .on(t.limitRuleId, t.simCardId, t.bucketStart)
      .nullsNotDistinct(),
    // Уборка по сроку ходит по началу окна.
    index('limit_counters_bucket_idx').on(t.bucketStart),
  ],
);
