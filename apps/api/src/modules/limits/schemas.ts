/**
 * Схемы ввода лимитов (ADR-0026).
 */

import { LIMIT_METRICS, LIMIT_WINDOWS } from '@zvonix/shared';
import { z } from 'zod';

/**
 * Новый лимит.
 *
 * Субъект — ровно один из четырёх. Проверяется службой и базой: лимит без субъекта
 * не относится ни к кому, а лимит на двоих сразу непонятно кого ограничивает.
 */
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
});

export const changeLimitSchema = z.object({
  value: z.coerce
    .number()
    .int('должно быть целым числом')
    .min(1, 'ноль означал бы «звонить нельзя вовсе», а это состояние субъекта')
    .max(10_000_000, 'неправдоподобно много'),
});
