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
import {
  ROUNDING_MODES,
  TERMINATION_KINDS,
  type Rounding,
  type TerminationKind,
} from '@zvonix/shared';
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

    /**
     * Приведённое написание региона (`regionKeyOf`). **По нему идёт сравнение**,
     * а не по `region`: раньше сравнивалась строка, и цена, заведённая как
     * `Красноярский кр.`, для вызова в `Красноярский край` не находилась — молча
     * подменялась общей ценой партнёра ([ADR-0023](../../../docs/adr/0023-koridory-cen.md)).
     */
    regionKey: text(),

    /**
     * Через что уходит вызов по этой цене
     * ([ADR-0040](../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)).
     *
     * У партнёра с SIM и SIP-транком два прайса, различающихся в разы: внутри своей
     * сети SIM почти бесплатна, транзит платный всегда. Без этого измерения партнёр
     * не может назначить транку свою цену — одна строка описывала бы оба случая.
     *
     * Умолчание `sim` нужно **миграции**: на момент её появления другого способа
     * не существует. API требует значение явно.
     */
    terminationKind: text().$type<TerminationKind>().notNull().default('sim'),

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
    // Ключ есть тогда и только тогда, когда есть регион: ключ без региона нечего
    // показывать человеку, регион без ключа недостижим при отборе.
    check('partner_rates_region_key_paired', sql`(${t.region} is null) = (${t.regionKey} is null)`),
    check('partner_rates_termination_kind_check', oneOf(t.terminationKind, TERMINATION_KINDS)),
    // Горячий путь: действующий тариф партнёра по направлению на момент вызова.
    // Способ терминации — сразу после партнёра: отбор кандидатов спрашивает цены
    // пачкой по способу, а не по одному направлению.
    index('partner_rates_lookup_idx').on(
      t.partnerId,
      t.terminationKind,
      t.operatorId,
      t.regionKey,
      t.effectiveFrom,
    ),
  ],
);

/**
 * Коридор цены по направлению ([ADR-0023](../../../docs/adr/0023-koridory-cen.md)).
 *
 * Границы сравниваются со **стоимостью эталонного вызова** по тарифу партнёра
 * (`referenceCost`), а не с одной лишь ценой за минуту: тариф — это пять чисел, и коридор,
 * ограничивающий одно из них, обходится платой за соединение или минимальной длительностью
 * в десять минут. Для простого тарифа стоимость эталонного вызова равна цене за минуту.
 *
 * Проверяется **при назначении цены**, а не при звонке: вызов не должен срываться из-за
 * того, что администратор сузил коридор, а цена, применённая к вызову, фиксируется в CDR
 * на его момент. Отсюда следствие — сужение коридора оставляет снаружи уже назначенные
 * цены; их показывает список нарушений.
 *
 * Версионирование то же, что у тарифов: строка не редактируется, добавляется новая
 * с `effective_from`.
 */
export const priceBands = pgTable(
  'price_bands',
  {
    id: primaryId<'priceBand'>(),

    operatorId: idRef<'operator'>()
      .notNull()
      .references(() => operators.id, { onDelete: 'restrict' }),

    /** Регион назначения. Пусто — «любой регион», как и у цены партнёра. */
    region: text(),

    /** Приведённое написание региона (`regionKeyOf`). По нему идёт сравнение. */
    regionKey: text(),

    /** Нижняя граница стоимости эталонного вызова. */
    minPrice: money().notNull(),

    /** Верхняя граница стоимости эталонного вызова. */
    maxPrice: money().notNull(),

    effectiveFrom: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('price_bands_min_non_negative', sql`${t.minPrice} >= 0`),
    // Пустой коридор (`max < min`) не запрещает цену, а делает невозможной любую:
    // такую опечатку лучше поймать вставкой, чем разбором «почему цена не заводится».
    check('price_bands_bounds', sql`${t.maxPrice} >= ${t.minPrice}`),
    check('price_bands_region_key_paired', sql`(${t.region} is null) = (${t.regionKey} is null)`),
    index('price_bands_lookup_idx').on(t.operatorId, t.regionKey, t.effectiveFrom),
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
