import { MESSAGE_MAX_LENGTH, MESSAGE_STATUSES } from '@zvonix/shared';
import { z } from 'zod';
import { boundedLimit, boundedOffset } from '../../http/pagination.js';
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

/** Облачный пароль MAX для завершения входа. Не обрезается и не нормализуется: пробелы в нём бывают значимыми. */
export const sendPasswordSchema = z.object({
  password: z.string().min(1, 'введите пароль').max(64, 'слишком длинный'),
});

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

/** Что клиент меняет в подключении SMPP: включить/отключить и список разрешённых адресов. */
export const updateSmppSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedIps: z.array(z.string().trim().min(1).max(45)).max(20, 'слишком много').optional(),
  })
  .refine((body) => body.enabled !== undefined || body.allowedIps !== undefined, {
    message: 'Нечего менять',
  });

/** Обзор для сотрудников: число суток и смещение часового пояса браузера (минуты к востоку от UTC). */
export const messagesOverviewQuerySchema = z.object({
  days: z
    .string()
    .optional()
    .transform((raw) => Number(raw ?? '14'))
    .pipe(z.number().int().min(1).max(90)),
  offset: z
    .string()
    .optional()
    .transform((raw) => Number(raw ?? '0'))
    .pipe(z.number().int().min(-720).max(840)),
});

/** Сотрудник отключает или возвращает подключение SMPP клиента. */
export const staffSmppSchema = z.object({ enabled: z.boolean() });

/** Пустое значение параметра — «любое»: форма отбора шлёт все свои поля. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

/** Отправка сообщения: кому, что и (необязательно) ключ, по которому повтор узнаётся. */
export const sendMessageSchema = z.object({
  to: z.string().trim().min(5, 'слишком короткий').max(30, 'слишком длинный'),
  text: z.string().min(1, 'не может быть пустым').max(MESSAGE_MAX_LENGTH, 'слишком длинное'),
  /** Ключ идемпотентности клиента: тот же ключ — то же сообщение, деньги не списываются дважды. */
  externalId: z
    .string()
    .trim()
    .min(1, 'не может быть пустым')
    .max(100, 'слишком длинный')
    .optional(),
});

export const messagesQuerySchema = z.object({
  status: optional(z.enum(MESSAGE_STATUSES)),
  limit: z
    .string()
    .optional()
    .transform((raw) => boundedLimit(raw, 200)),
  offset: z.string().optional().transform(boundedOffset),
});

/** Уведомление провайдера: берём только нужное, остальное игнорируем (состав полей у него меняется). */
export const providerWebhookSchema = z.looseObject({
  typeWebhook: z.string().optional(),
  idMessage: z.string().optional(),
  status: z.string().optional(),
  instanceData: z
    .looseObject({ idInstance: z.union([z.string(), z.number()]).optional() })
    .optional(),
});
