/**
 * Схемы ввода лимитов (ADR-0026).
 */

import {
  LIMIT_METRICS,
  LIMIT_PERIOD_START_DAY_MAX,
  LIMIT_ROUNDINGS,
  LIMIT_WINDOWS,
  PARTNER_LIMIT_METRICS,
} from '@zvonix/shared';
import { z } from 'zod';

/**
 * Новый лимит.
 *
 * Субъект — ровно один из четырёх. Проверяется службой и базой: лимит без субъекта
 * не относится ни к кому, а лимит на двоих сразу непонятно кого ограничивает.
 */
/** Счёт минут и день обновления месяца — у правила любого субъекта (ADR-0057). */
const rounding = z.enum(LIMIT_ROUNDINGS);
const periodStartDay = z.coerce
  .number()
  .int('должен быть целым числом')
  .min(1, 'от 1')
  .max(
    LIMIT_PERIOD_START_DAY_MAX,
    `до ${String(LIMIT_PERIOD_START_DAY_MAX)}: в феврале дальше дней нет`,
  );

export const addLimitSchema = z.object({
  clientId: z.uuid('должен быть идентификатором').optional(),
  channelId: z.uuid('должен быть идентификатором').optional(),
  partnerId: z.uuid('должен быть идентификатором').optional(),
  simCardId: z.uuid('должен быть идентификатором').optional(),

  window: z.enum(LIMIT_WINDOWS),
  metric: z.enum(LIMIT_METRICS),

  /** Звонков, минут или рублей за окно. Ноль означал бы «нельзя вовсе» — это состояние, не лимит. */
  value: z.coerce
    .number()
    .int('должно быть целым числом')
    .min(1, 'ноль означал бы «звонить нельзя вовсе», а это состояние субъекта')
    .max(10_000_000, 'неправдоподобно много'),

  /** Правило партнёра — у каждой его SIM отдельно (ADR-0057). */
  perSim: z.boolean().default(false),
  rounding: rounding.default('second'),
  periodStartDay: periodStartDay.nullable().optional(),
});

export const changeLimitSchema = z.object({
  value: z.coerce
    .number()
    .int('должно быть целым числом')
    .min(1, 'ноль означал бы «звонить нельзя вовсе», а это состояние субъекта')
    .max(10_000_000, 'неправдоподобно много'),
  rounding: rounding.optional(),
  periodStartDay: periodStartDay.nullable().optional(),
});

/**
 * Лимит, который партнёр задаёт себе сам (ADR-0057, ADR-0080). Основной путь — `tariff`:
 * лимит в тарифе действует на каждую карту этого тарифа. Прежние виды (`partner` — все карты
 * вместе, `each_sim`, `sim`) остаются, пока их не перенесли в тарифы; партнёр — из сессии.
 */
export const partnerLimitSchema = addLimitSchema
  .omit({ clientId: true, channelId: true, partnerId: true, perSim: true })
  .extend({
    // Денег на звонки у партнёра нет: лимит денег — только у клиента (ADR-0102).
    metric: z.enum(PARTNER_LIMIT_METRICS),
    scope: z.enum(['partner', 'each_sim', 'sim', 'tariff']),
    tariffId: z.uuid('должен быть идентификатором').optional(),
  })
  .refine((body) => (body.scope === 'sim') === (body.simCardId !== undefined), {
    message: 'карта называется ровно тогда, когда лимит — на одну карту',
    path: ['simCardId'],
  })
  .refine((body) => (body.scope === 'tariff') === (body.tariffId !== undefined), {
    message: 'тариф называется ровно тогда, когда лимит — в тарифе',
    path: ['tariffId'],
  });

/**
 * Лимит, который клиент задаёт себе сам ([ADR-0102](../../../../../docs/adr/0102-chasovoy-poyas-akkaunta-i-limity.md)):
 * на все свои линии вместе (`client`) или на одну (`channel`). «На каждую карту» и день обновления месяца — понятия
 * партнёра, у клиента их нет; минуты считаются посекундно, как и тарифицируются.
 */
export const clientLimitSchema = addLimitSchema
  .pick({ window: true, metric: true, value: true })
  .extend({
    scope: z.enum(['client', 'channel']),
    channelId: z.uuid('должен быть идентификатором').optional(),
  })
  .refine((body) => (body.scope === 'channel') === (body.channelId !== undefined), {
    message: 'линия называется ровно тогда, когда лимит — на одну линию',
    path: ['channelId'],
  });

/** Лимиту клиента меняется только предел: остальное — другое правило. */
export const changeClientLimitSchema = changeLimitSchema.pick({ value: true });

/** Часовой пояс аккаунта — имя IANA (ADR-0102). Проверку по списку среды делает служба. */
export const accountTimezoneSchema = z.object({
  timezone: z.string().trim().min(1, 'пояс не выбран').max(64, 'слишком длинное имя пояса'),
});
