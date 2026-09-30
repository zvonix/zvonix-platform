/**
 * Схемы входных данных модуля учётных записей.
 *
 * Лежат отдельно от контроллера, потому что переиспользуются фронтендом (ADR-0008):
 * одна схема — одно место, где описано, что считается допустимым.
 */

import { z } from 'zod';
import { APPLICATION_STATUSES, USER_ROLES, USER_STATUSES } from '@zvonix/shared';
import { boundedLimit, boundedOffset } from '../../http/pagination.js';

/**
 * Потолок страницы списка учётных записей.
 *
 * Меньше общего потолка API: это таблица, которую читает человек, а не выгрузка.
 * Тысяча строк на экране не помогает никому, а базу заставляет их отдать.
 */
const USER_PAGE_MAX = 200;

/**
 * Адрес приводится к нижнему регистру здесь, на границе.
 *
 * В базе стоит ограничение `email = lower(email)`: без приведения регистр
 * из формы просто вызвал бы отказ вставки. Приводить в двух местах нельзя —
 * приводим в одном, а база проверяет, что это не забыли.
 */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'слишком короткий')
  .max(254, 'слишком длинный')
  .pipe(z.email('не похож на адрес почты'));

/**
 * Длина вместо требований к составу символов.
 *
 * Правила «одна заглавная, одна цифра, один спецсимвол» заставляют людей писать
 * `Password1!` и снижают стойкость. Длина — единственное требование, которое
 * действительно работает; верхняя граница нужна, чтобы мегабайтная строка
 * не занимала процессор на хешировании.
 */
const password = z.string().min(12, 'не короче 12 символов').max(200, 'не длиннее 200 символов');

/**
 * Токен проверки «я не робот» ([ADR-0031](../../../../../docs/adr/0031-nastroyki-ploshchadki.md)).
 *
 * Необязателен в схеме, а не в правиле: обязательность зависит от настройки площадки,
 * и вторая копия этого условия в схеме разъехалась бы с первой. Отсутствие токена
 * при включённой капче отвергает служба.
 */
const captchaToken = z.string().trim().max(4096, 'слишком длинный').optional();

/**
 * Телефон для связи по заявке. Проверяется форма, а не принадлежность номера:
 * администратор звонит по нему сам, и приведение к одному виду здесь не нужно.
 */
const phone = z
  .string()
  .trim()
  .regex(/^\+?[\d\s()-]{10,20}$/u, 'не похож на телефон');

/** Необязательное число «примерно»: пустое поле формы приходит как отсутствие поля. */
const roughCount = z
  .number()
  .int('целое число')
  .min(1, 'не меньше 1')
  .max(1_000_000, 'слишком много');

/**
 * Анкета клиента ([ADR-0052](../../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 *
 * Ничего обязательного (владелец, 2026-09-30): клиент — не только служба такси, но и
 * человек, который звонит друзьям, и спрашивать у него название и телефон незачем.
 * Поля остаются необязательными ради заявок, поданных до этого. Карточка называется
 * `companyName`, а без него — именем заявителя.
 */
const clientAnswers = z
  .object({
    companyName: z
      .string()
      .trim()
      .min(2, 'слишком короткое')
      .max(200, 'слишком длинное')
      .optional(),
    city: z.string().trim().min(2, 'слишком короткое').max(100, 'слишком длинное').optional(),
    phone: phone.optional(),
    callsPerDay: roughCount.optional(),
  })
  .strict();

/**
 * Анкета партнёра. Операторы — названиями, как их знает человек: справочник площадки
 * ему до одобрения не открыт, и сверяет их администратор.
 */
const partnerAnswers = z
  .object({
    region: z.string().trim().min(2, 'слишком короткое').max(100, 'слишком длинное').optional(),
    phone: phone.optional(),
    simCount: roughCount.optional(),
    operators: z
      .array(z.string().trim().min(1, 'пустое название').max(50, 'слишком длинное'))
      .max(10, 'не больше десяти')
      .optional(),
  })
  .strict();

/**
 * Заявка на кабинет: вид кабинета и анкета именно этого вида. Сотрудника площадки
 * заявкой не получить: вид — только клиент или партнёр.
 */
export const applicationSchema = z.discriminatedUnion('cabinet', [
  z.object({ cabinet: z.literal('client'), answers: clientAnswers }),
  z.object({ cabinet: z.literal('partner'), answers: partnerAnswers }),
]);
export type ApplicationInput = z.infer<typeof applicationSchema>;

/**
 * Регистрация — учётная запись участника и первая заявка одной формой
 * (ADR-0052). Роль не выбирается: самостоятельно заводится только участник рынка,
 * `admin` и `support` заводит команда `admin:create`.
 */
export const registerSchema = z
  .object({
    email,
    password,
    fullName: z.string().trim().min(2, 'слишком короткое').max(200, 'слишком длинное'),
    captchaToken,
  })
  .and(applicationSchema);

/** Отказ по заявке: причина уходит человеку письмом, поэтому обязательна. */
export const rejectApplicationSchema = z.object({
  note: z.string().trim().min(3, 'назовите причину').max(1000, 'слишком длинная'),
});

/**
 * Одобрение заявки. Псевдоним нужен только партнёру — под ним его увидят клиенты
 * (ADR-0014), и выбирает его администратор, а не сам партнёр.
 */
export const approveApplicationSchema = z.object({
  displayName: z.string().trim().min(2, 'слишком короткий').max(60, 'слишком длинный').optional(),
});

/**
 * Первый запуск (ADR-0050): код из вывода выкладки и учётная запись первого администратора.
 *
 * Код здесь проверяется только по форме — пустой и огромный не доходят до HMAC; подходит ли
 * он, решает сервис. Почта и пароль — по тем же правилам, что у регистрации.
 */
export const firstRunSchema = z.object({
  code: z.string().trim().min(1, 'не может быть пустым').max(40, 'слишком длинный'),
  email,
  password,
  fullName: z.string().trim().min(2, 'слишком короткое').max(200, 'слишком длинное'),
});

/**
 * Код второго фактора: шесть цифр, возможно с пробелом посередине.
 *
 * Пробел терпится намеренно — аутентификаторы показывают код разбитым пополам,
 * и человек переносит его вместе с пробелом (ADR-0028).
 */
const totpCode = z.string().trim().min(6, 'шесть цифр').max(10, 'шесть цифр');

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'не может быть пустым').max(200, 'слишком длинный'),

  /** Нужен только тем, у кого включён второй фактор. Спрашивается после сверки пароля. */
  totpCode: totpCode.optional(),
  captchaToken,
});

/**
 * Смена пароля из кабинета.
 *
 * Текущий пароль обязателен: украденная сессия иначе превращается в украденную
 * учётную запись одним запросом.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'не может быть пустым').max(200, 'слишком длинный'),
  newPassword: password,
});

export const totpCodeSchema = z.object({ code: totpCode });

/** Отключение второго фактора: и пароль, и код — это снятие защиты. */
export const disableTotpSchema = z.object({
  password: z.string().min(1, 'не может быть пустым').max(200, 'слишком длинный'),
  code: totpCode,
});

export type RegisterInput = z.infer<typeof registerSchema>;
/** Повторное письмо без входа: адрес и пароль вместо сессии, капча та же, что у входа. */
export const emailResendByPasswordSchema = loginSchema.pick({
  email: true,
  password: true,
  captchaToken: true,
});

export type LoginInput = z.infer<typeof loginSchema>;
export type FirstRunInput = z.infer<typeof firstRunSchema>;

/** Запрос восстановления пароля. Ответ одинаков независимо от того, есть ли запись. */
export const passwordResetRequestSchema = z.object({ email, captchaToken });

/** Одноразовый токен из письма. */
export const tokenSchema = z.object({
  token: z.string().trim().min(20, 'не похоже на ссылку из письма').max(200, 'слишком длинный'),
});

export const passwordResetConfirmSchema = tokenSchema.extend({ newPassword: password });

/**
 * Отбор для списка учётных записей.
 *
 * Пустое значение параметра приравнивается к отсутствию: форма отбора шлёт все свои
 * поля, и `?role=` означает «любая роль», а не «роль с пустым именем». Без этого
 * сброс фильтра в интерфейсе давал бы отказ вместо полного списка.
 *
 * Границы страницы разбираются общими правилами
 * ([pagination.ts](../../http/pagination.ts)): мусор в адресе даёт умолчание,
 * а не ошибку — список не то место, где опечатка должна прятать данные.
 */
const optionalParameter = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);

export const userListQuerySchema = z.object({
  role: optionalParameter.pipe(z.enum(USER_ROLES).optional()),
  status: optionalParameter.pipe(z.enum(USER_STATUSES).optional()),
  email: optionalParameter.pipe(z.string().trim().max(254, 'слишком длинный').optional()),
  limit: z
    .string()
    .optional()
    .transform((raw) => boundedLimit(raw, USER_PAGE_MAX)),
  offset: z.string().optional().transform(boundedOffset),
});

/** Потолок страницы очереди заявок — таблица, которую читает человек. */
const APPLICATION_PAGE_MAX = 200;

export const applicationListQuerySchema = z.object({
  status: optionalParameter.pipe(z.enum(APPLICATION_STATUSES).optional()),
  limit: z
    .string()
    .optional()
    .transform((raw) => boundedLimit(raw, APPLICATION_PAGE_MAX)),
  offset: z.string().optional().transform(boundedOffset),
});
