/**
 * Схемы входных данных платежей ([ADR-0064](../../../../../docs/adr/0064-platezhi-karkas.md)).
 *
 * Сумма принимается строкой, как везде в биллинге: число с плавающей точкой копейки теряет.
 */

import { PAYMENT_STATUSES } from '@zvonix/shared';
import { z } from 'zod';
import { boundedLimit, boundedOffset } from '../../http/pagination.js';
import { amount } from '../billing/schemas.js';

export const createPaymentSchema = z.object({
  amount,
  /** Пометка клиента: номер платёжки, за что. Администратору проще найти перевод. */
  comment: z
    .string()
    .trim()
    .max(300, 'слишком длинная')
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value)),
});

/** Подтверждение: сколько пришло на самом деле. Не названо — столько, сколько просил клиент. */
export const confirmPaymentSchema = z.object({
  amount: amount.optional(),
});

export const rejectPaymentSchema = z.object({
  /** Причина видна клиенту: «перевод не поступил», «сумма не совпала». */
  reason: z.string().trim().min(3, 'слишком короткая').max(300, 'слишком длинная'),
});

/** Пустое значение параметра — «любое»: форма отбора шлёт все свои поля. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

export const paymentsQuerySchema = z.object({
  status: optional(z.enum(PAYMENT_STATUSES)),
  clientId: optional(z.uuid('должен быть идентификатором')),
  limit: z
    .string()
    .optional()
    .transform((raw) => boundedLimit(raw, 200)),
  offset: z.string().optional().transform(boundedOffset),
});
