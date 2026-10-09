import {
  DISTRIBUTION_MODES,
  DISTRIBUTION_RANK_MAX,
  DISTRIBUTION_RESERVE_MAX,
  MESSAGE_MAX_LENGTH,
  MESSAGE_STATUSES,
  SMPP_RECEIPT_ACTIONS,
} from '@zvonix/shared';
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

/** Что партнёр меняет у аккаунта: только название. Цена и лимиты — в тарифе ([ADR-0075](../../../../../docs/adr/0075-tarify-max-nabor-uslovij.md)). */
export const updateAccountSchema = z.object({ label });

const minuteOfDay = z.number().int('должно быть целым числом').min(0).max(1439);

/**
 * Настройка распределения партнёра ([ADR-0080](../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)).
 * Тихие часы — обе границы или ни одной; пояс — название из базы часовых поясов.
 */
export const distributionSchema = z
  .object({
    mode: z.enum(DISTRIBUTION_MODES),
    reservePercent: z.number().int('должно быть целым числом').min(0).max(DISTRIBUTION_RESERVE_MAX),
    quietFromMinute: minuteOfDay.nullable(),
    quietToMinute: minuteOfDay.nullable(),
    timezone: z
      .string()
      .trim()
      .min(1, 'укажите пояс')
      .max(64)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, 'неизвестный часовой пояс'),
    stickyRecipient: z.boolean(),
  })
  .refine((body) => (body.quietFromMinute === null) === (body.quietToMinute === null), {
    message: 'Тихие часы — начало и конец вместе',
  })
  .refine((body) => body.quietFromMinute === null || body.quietFromMinute !== body.quietToMinute, {
    message: 'Начало и конец тихих часов не должны совпадать',
  });

/** Вес и приоритет аккаунта в распределении; что не названо — не меняется. */
export const accountRankSchema = z
  .object({
    weight: z.number().int().min(1).max(DISTRIBUTION_RANK_MAX).optional(),
    priority: z.number().int().min(1).max(DISTRIBUTION_RANK_MAX).optional(),
  })
  .refine((body) => body.weight !== undefined || body.priority !== undefined, {
    message: 'Нечего менять',
  });

/** Автопрогрев аккаунта: включить или выключить. */
export const warmupSchema = z.object({ enabled: z.boolean() });

const tariffName = z.string().trim().min(1, 'слишком короткое').max(60, 'слишком длинное');
const tariffLimit = limit;

/** Новый тариф MAX: имя, цена за сообщение, лимиты (пусто — без ограничения), «по умолчанию». */
export const createTariffSchema = z.object({
  name: tariffName,
  price: amount,
  limitPerMinute: tariffLimit.default(null),
  limitPerDay: tariffLimit.default(null),
  isDefault: z.boolean().default(false),
});

/** Правка тарифа: не названное не трогается; `null` у лимита — снять. */
export const updateTariffSchema = z
  .object({
    name: tariffName.optional(),
    price: amount.optional(),
    limitPerMinute: tariffLimit.optional(),
    limitPerDay: tariffLimit.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Нечего менять',
  });

/** Назначение тарифа аккаунту; `null` — идти за тарифом по умолчанию. */
export const assignTariffSchema = z.object({
  tariffId: z.uuid('должен быть идентификатором').nullable(),
});

/** Ручное заведение администратором: данные готового инстанса. Ключ в ответы не попадает. */
export const registerAccountSchema = z.object({
  partnerId: z.uuid('должен быть идентификатором'),
  label,
  instanceId: z.string().trim().min(1, 'не может быть пустым').max(40, 'слишком длинный'),
  token: z.string().trim().min(1, 'не может быть пустым').max(200, 'слишком длинный'),
  apiUrl: z.url('должен быть адресом').max(200, 'слишком длинный'),
});

/** Что клиент меняет в подключении SMPP: включить/отключить, список разрешённых адресов и отчёты. */
export const updateSmppSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedIps: z.array(z.string().trim().min(1).max(45)).max(20, 'слишком много').optional(),
    /** Что отдавать по SMPP на каждое событие с сообщением (ADR-0076); присылаются все три сразу. */
    receipts: z
      .object({
        sent: z.enum(SMPP_RECEIPT_ACTIONS),
        delivered: z.enum(SMPP_RECEIPT_ACTIONS),
        read: z.enum(SMPP_RECEIPT_ACTIONS),
      })
      .optional(),
  })
  .refine(
    (body) =>
      body.enabled !== undefined || body.allowedIps !== undefined || body.receipts !== undefined,
    { message: 'Нечего менять' },
  );

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
