/**
 * Схемы входных данных модуля учётных записей.
 *
 * Лежат отдельно от контроллера, потому что переиспользуются фронтендом (ADR-0008):
 * одна схема — одно место, где описано, что считается допустимым.
 */

import { z } from 'zod';
import { USER_ROLES, USER_STATUSES, type UserRole } from '@zvonix/shared';
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
 * Роли, доступные при самостоятельной регистрации.
 *
 * `admin` и `support` заводит только администратор: иначе доступ ко всей платформе
 * получает любой, кто отправил форму. `satisfies` следит, чтобы список не разошёлся
 * с перечислением домена — опечатка в роли здесь была бы принята схемой молча.
 */
const SELF_SERVICE_ROLES = ['client', 'partner'] as const satisfies readonly UserRole[];

/**
 * Токен проверки «я не робот» ([ADR-0031](../../../../../docs/adr/0031-nastroyki-ploshchadki.md)).
 *
 * Необязателен в схеме, а не в правиле: обязательность зависит от настройки площадки,
 * и вторая копия этого условия в схеме разъехалась бы с первой. Отсутствие токена
 * при включённой капче отвергает служба.
 */
const captchaToken = z.string().trim().max(4096, 'слишком длинный').optional();

export const registerSchema = z.object({
  email,
  password,
  fullName: z.string().trim().min(2, 'слишком короткое').max(200, 'слишком длинное'),
  role: z.enum(SELF_SERVICE_ROLES),
  captchaToken,
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
export type LoginInput = z.infer<typeof loginSchema>;

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
