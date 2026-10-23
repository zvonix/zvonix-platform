import {
  MESSAGE_BUSY_MODES,
  MESSAGE_WAIT_MINUTES_MAX,
  ACCOUNT_MIN_AGE_DAYS_MAX,
  STOP_LINE_REQUIREMENTS,
  MESSAGE_MAX_LENGTH,
  MESSAGE_STATUSES,
  SMPP_RECEIPT_ACTIONS,
  SMPP_RECEIPT_FINAL_ACTIONS,
  TEMPLATE_BLOCKS_MAX,
  TEMPLATE_BLOCK_KINDS,
  TEMPLATE_TEXT_MAX,
  TEMPLATE_VIA,
  TEMPLATE_WHEN,
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

/** Пробное сообщение: получатель и, по желанию, короткий текст. Без текста уходит «Проверка связи Zvonix». */
export const testMessageSchema = z.object({
  recipient: z.string().trim().min(5, 'введите номер').max(20, 'слишком длинный'),
  text: z.string().trim().min(1, 'пустой текст').max(200, 'не длиннее 200 знаков').optional(),
});

/** Что партнёр меняет у аккаунта: только название. Цена и лимиты — в тарифе ([ADR-0075](../../../../../docs/adr/0075-tarify-max-nabor-uslovij.md)). */
/** Партнёр меняет своё: название, «СТОП» в сообщениях и «рекомендованную работу» (ADR-0088, ADR-0090, ADR-0092). */
export const updateAccountSchema = z
  .object({
    label: label.optional(),
    stopLine: z.boolean().optional(),
    recommended: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.label !== undefined || body.stopLine !== undefined || body.recommended !== undefined,
    {
      message: 'Нечего менять',
    },
  );

/** Автопрогрев аккаунта: включить или выключить. */
export const warmupSchema = z.object({ enabled: z.boolean() });

const tariffName = z.string().trim().min(1, 'слишком короткое').max(60, 'слишком длинное');
const tariffLimit = limit;

/** Новый тариф MAX: имя, цена за сообщение, лимиты (пусто — без ограничения), «по умолчанию». */
export const createTariffSchema = z.object({
  name: tariffName,
  price: amount,
  limitPerMinute: tariffLimit.default(null),
  limitPerHour: tariffLimit.default(null),
  limitPerDay: tariffLimit.default(null),
  isDefault: z.boolean().default(false),
});

/** Правка тарифа: не названное не трогается; `null` у лимита — снять. */
export const updateTariffSchema = z
  .object({
    name: tariffName.optional(),
    price: amount.optional(),
    limitPerMinute: tariffLimit.optional(),
    limitPerHour: tariffLimit.optional(),
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
        delivered: z.enum(SMPP_RECEIPT_FINAL_ACTIONS),
        read: z.enum(SMPP_RECEIPT_FINAL_ACTIONS),
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

/** Отчёт для сотрудников: за сколько суток (по умолчанию неделя). */
export const messagesReportQuerySchema = z.object({
  days: z
    .string()
    .optional()
    .transform((raw) => Number(raw ?? '7'))
    .pipe(z.number().int().min(1).max(90)),
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
  /** Срок сообщения, минут (ADR-0097): не ушло за это время — отказ с возвратом денег. Меньшее из этого и «сколько ждать». */
  validMinutes: z
    .number()
    .int('должно быть целым числом')
    .min(1, 'не меньше 1')
    .max(MESSAGE_WAIT_MINUTES_MAX, `не больше ${String(MESSAGE_WAIT_MINUTES_MAX)}`)
    .optional(),
});

/** «Если отправить сразу нельзя» и «сколько ждать» клиента (ADR-0097); `null` — по умолчанию. */
export const deliverySchema = z.object({
  busyMode: z.enum(MESSAGE_BUSY_MODES).nullable(),
  maxWaitMinutes: z
    .number()
    .int('должно быть целым числом')
    .min(1, 'не меньше 1')
    .max(MESSAGE_WAIT_MINUTES_MAX, `не больше ${String(MESSAGE_WAIT_MINUTES_MAX)}`)
    .nullable(),
});

/** Момент времени ISO для отбора журнала по периоду, как у вызовов. */
const moment = optional(
  z.iso.datetime({ offset: true, message: 'должен быть моментом времени в виде ISO' }),
);

/**
 * Отбор журнала сообщений: состояние, период, у сотрудников — клиент и партнёр. Журнал отдавал последние 50 без отбора,
 * а у вызовов было всё (владелец, 2026-10-23).
 */
export const messagesQuerySchema = z.object({
  status: optional(z.enum(MESSAGE_STATUSES)),
  from: moment,
  to: moment,
  clientId: optional(z.uuid('должен быть идентификатором')),
  partnerId: optional(z.uuid('должен быть идентификатором')),
  limit: z
    .string()
    .optional()
    .transform((raw) => boundedLimit(raw, 200)),
  offset: z.string().optional().transform(boundedOffset),
});

/**
 * Журнал кабинета (клиент, сотрудники) — с отклонёнными при приёме (ADR-0098): `refused=1` — вместе с ними, `status=refused` —
 * только они. Внешний `GET /v1/messages` идёт по `messagesQuerySchema` и не меняется.
 */
export const journalQuerySchema = messagesQuerySchema.extend({
  status: optional(z.enum([...MESSAGE_STATUSES, 'refused'])),
  refused: optional(z.enum(['1', 'true'])),
});

/** Список «не писать»: поиск по полному номеру и страница. */
export const stopsQuerySchema = z.object({
  phone: optional(z.string().trim().max(30)),
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

/**
 * Шаблон сообщения клиента ([ADR-0087](../../../../../docs/adr/0087-konstruktor-soobshcheniya.md)). У `greeting` и
 * `text` текст обязателен и не длиннее предела, у `body` и `bot_link` его нет; `body` — ровно один, всегда «всегда».
 */
const templateBlockSchema = z
  .object({
    kind: z.enum(TEMPLATE_BLOCK_KINDS),
    text: z
      .string()
      .trim()
      .max(TEMPLATE_TEXT_MAX, `не длиннее ${String(TEMPLATE_TEXT_MAX)} знаков`)
      .optional(),
    when: z.enum(TEMPLATE_WHEN),
    via: z.enum(TEMPLATE_VIA).optional(),
  })
  .strict()
  .refine(
    (block) => (block.kind !== 'greeting' && block.kind !== 'text') || (block.text ?? '') !== '',
    { message: 'Введите текст блока' },
  )
  .refine(
    (block) => block.kind === 'greeting' || block.kind === 'text' || block.text === undefined,
    { message: 'У этого блока текста нет' },
  )
  .refine(
    (block) => block.kind !== 'body' || (block.when === 'always' && (block.via ?? 'all') === 'all'),
    {
      message: 'Текст сообщения идёт всегда и везде',
    },
  );

export const templateSchema = z.object({
  blocks: z
    .array(templateBlockSchema)
    .min(1, 'Нужен хотя бы один блок')
    .max(TEMPLATE_BLOCKS_MAX, `Не больше ${String(TEMPLATE_BLOCKS_MAX)} блоков`)
    .refine((blocks) => blocks.filter((block) => block.kind === 'body').length === 1, {
      message: 'В сообщении должен быть ровно один блок «Текст сообщения»',
    }),
});

/** Требования клиента к аккаунтам MAX ([ADR-0092](../../../../../docs/adr/0092-trebovaniya-klienta-k-akkauntam.md)). */
export const requirementsSchema = z.object({
  stopLine: z.enum(STOP_LINE_REQUIREMENTS),
  recommendedOnly: z.boolean(),
  /** Цена сообщения для клиента не дороже; `null` — без предела. */
  maxPrice: amount.refine((value) => value > 0n, 'должна быть больше нуля').nullable(),
  minAgeDays: z
    .number()
    .int('должно быть целым числом')
    .min(1, 'не меньше 1')
    .max(ACCOUNT_MIN_AGE_DAYS_MAX, `не больше ${String(ACCOUNT_MIN_AGE_DAYS_MAX)}`)
    .nullable(),
});

/** Клиент отключает аккаунт для себя или возвращает его. */
export const exclusionSchema = z.object({ excluded: z.boolean() });
