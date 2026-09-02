/**
 * Тарифы партнёров и наценка платформы (ADR-0010).
 *
 * **Направление — это пара «оператор и регион», а не префикс номера.** DOMAIN.md описывал
 * его как «префикс → оператор/регион», но [ADR-0013](../../docs/adr/0013-opredelenie-operatora.md)
 * запрещает определять оператора по префиксу: из-за переносимости номеров это неверный
 * оператор, а неверный оператор — платный звонок с денег партнёра. Тариф, привязанный
 * к префиксу, воспроизвёл бы ровно ту ошибку, ради недопущения которой существует резолвер.
 *
 * Поэтому направление берётся из ответа `OperatorResolver`, и префикс в тарификации
 * не участвует вовсе.
 *
 * **Версионирование — только через `effective_from`.** Действует запись с наибольшим
 * `effective_from`, не превышающим момент вызова. Даты окончания нет намеренно: цена,
 * применённая к звонку, фиксируется в CDR на момент звонка, и прошлое от изменения
 * тарифа не меняется (инвариант DOMAIN.md). Строка тарифа не редактируется —
 * добавляется новая.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { ROUNDING_MODES, type Rounding } from '@zvonix/shared';
import { createdAt, idRef, money, oneOf, primaryId, timestamptz } from '../columns.js';
import { clients, partners } from './billing.js';
import { operators } from './catalog.js';

/**
 * Цена партнёра и его правила тарификации.
 *
 * Правила задаёт партнёр (DOMAIN.md): шаг, минимальная длительность и плата
 * за соединение — часть его тарифа, а не общая настройка платформы.
 */
export const partnerRates = pgTable(
  'partner_rates',
  {
    id: primaryId<'partnerRate'>(),
    partnerId: idRef<'partner'>()
      .notNull()
      .references(() => partners.id, { onDelete: 'restrict' }),

    /** Оператор назначения. Берётся из ответа резолвера, а не из префикса номера. */
    operatorId: idRef<'operator'>()
      .notNull()
      .references(() => operators.id, { onDelete: 'restrict' }),

    /**
     * Регион назначения. Пусто — «любой регион».
     *
     * Запись с указанным регионом побеждает запись без него: так частный случай
     * уточняет общий, а не спорит с ним.
     */
    region: text(),

    /** Цена за полную минуту разговора. */
    pricePerMinute: money().notNull(),

    /** Шаг тарификации в секундах. Посекундная тарификация — это шаг, равный единице. */
    billingIncrementSeconds: integer().notNull().default(1),

    /**
     * Минимальная оплачиваемая длительность — **первый оплачиваемый период целиком**,
     * а не нижняя граница округления. При минимуме 45 и шаге 30 разговор в 50 секунд
     * стоит 45 + 30 секунд.
     */
    minimumDurationSeconds: integer().notNull().default(0),

    /** Плата за соединение. Берётся один раз с отвеченного вызова. */
    connectionFee: money()
      .notNull()
      .default(sql`0`),

    /** Правило округления — часть тарифа, а не свойство кода (ADR-0010). */
    rounding: text().$type<Rounding>().notNull().default('half_away_from_zero'),

    effectiveFrom: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('partner_rates_rounding_check', oneOf(t.rounding, ROUNDING_MODES)),
    check('partner_rates_price_non_negative', sql`${t.pricePerMinute} >= 0`),
    check('partner_rates_connection_fee_non_negative', sql`${t.connectionFee} >= 0`),
    check('partner_rates_increment_positive', sql`${t.billingIncrementSeconds} >= 1`),
    check('partner_rates_minimum_non_negative', sql`${t.minimumDurationSeconds} >= 0`),
    // Горячий путь: действующий тариф партнёра по направлению на момент вызова.
    index('partner_rates_lookup_idx').on(t.partnerId, t.operatorId, t.region, t.effectiveFrom),
  ],
);

/**
 * Наценка платформы: фиксированная сумма за вызов и процент от стоимости партнёра.
 *
 * Применяются **вместе**, а не по выбору: фикс покрывает стоимость самого факта вызова,
 * процент — долю от объёма (DOMAIN.md, ответ 2026-09-01).
 */
export const commissionRules = pgTable(
  'commission_rules',
  {
    id: primaryId<'commissionRule'>(),

    /**
     * Клиент, к которому относится правило. Пусто — правило платформы по умолчанию.
     * Правило для конкретного клиента побеждает общее.
     */
    clientId: idRef<'client'>().references(() => clients.id, { onDelete: 'cascade' }),

    /** Фиксированная часть за вызов. */
    fixedFee: money()
      .notNull()
      .default(sql`0`),

    /**
     * Доля от стоимости партнёра в десятитысячных: 15% = 1500.
     *
     * Значение по умолчанию задаётся выражением, а не литералом `0n`: drizzle-kit
     * не умеет сериализовать `BigInt` при генерации миграции и падает на нём.
     */
    percentBasisPoints: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),

    effectiveFrom: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('commission_rules_fixed_fee_non_negative', sql`${t.fixedFee} >= 0`),
    // Верхняя граница намеренная: наценка выше 100% означает опечатку в разрядах,
    // а не коммерческое решение. Такую опечатку лучше поймать вставкой, чем счётом.
    check('commission_rules_percent_range', sql`${t.percentBasisPoints} between 0 and 10000`),
    index('commission_rules_lookup_idx').on(t.clientId, t.effectiveFrom),
  ],
);
