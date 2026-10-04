import { z } from 'zod';
import { amount } from '../billing/schemas.js';

const label = z.string().trim().min(2, 'слишком короткое').max(60, 'слишком длинное');

const limit = z
  .number()
  .int('должно быть целым числом')
  .min(1, 'не меньше 1')
  .max(1_000_000, 'слишком много')
  .nullable();

/** Новый аккаунт MAX партнёра: от него нужно только название, остальное делает площадка. */
export const createAccountSchema = z.object({ label });

/** Что партнёр меняет у аккаунта. Не названное — не трогается; `null` у цены и лимита — снять. */
export const updateAccountSchema = z
  .object({
    label: label.optional(),
    price: amount.nullable().optional(),
    limitPerMinute: limit.optional(),
    limitPerDay: limit.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Нечего менять',
  });

/** Ручное заведение администратором: данные готового инстанса. Ключ в ответы не попадает. */
export const registerAccountSchema = z.object({
  partnerId: z.uuid('должен быть идентификатором'),
  label,
  instanceId: z.string().trim().min(1, 'не может быть пустым').max(40, 'слишком длинный'),
  token: z.string().trim().min(1, 'не может быть пустым').max(200, 'слишком длинный'),
  apiUrl: z.url('должен быть адресом').max(200, 'слишком длинный'),
});
