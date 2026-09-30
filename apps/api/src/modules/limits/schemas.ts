/**
 * Схемы ввода лимитов (ADR-0026).
 */

import {
  LIMIT_METRICS,
  LIMIT_PERIOD_START_DAY_MAX,
  LIMIT_ROUNDINGS,
  LIMIT_WINDOWS,
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

  /** Звонков или минут за окно. Ноль означал бы «нельзя вовсе» — это состояние, не лимит. */
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
 * Лимит, который партнёр задаёт себе сам (ADR-0057). Субъект — он сам (`partner`),
 * каждая его карта (`each_sim`) или одна карта (`sim` с `simCardId`); партнёр — из сессии.
 */
export const partnerLimitSchema = addLimitSchema
  .omit({ clientId: true, channelId: true, partnerId: true, perSim: true })
  .extend({ scope: z.enum(['partner', 'each_sim', 'sim']) })
  .refine((body) => (body.scope === 'sim') === (body.simCardId !== undefined), {
    message: 'карта называется ровно тогда, когда лимит — на одну карту',
    path: ['simCardId'],
  });
