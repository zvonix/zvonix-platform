/**
 * Перечисления домена.
 *
 * Держатся здесь, а не в схеме базы и не в контроллерах, потому что нужны сразу троим:
 * схеме Drizzle (ограничение CHECK), схемам zod на границе API и коду приложения.
 * Три независимых списка разошлись бы на первом же добавлении значения.
 *
 * Значения — из docs/DOMAIN.md, раздел «Роли» и «Жизненные циклы».
 * Формат значения: строчные латинские буквы и подчёркивание. Это не косметика —
 * значения подставляются в текст ограничения CHECK при генерации миграции.
 */

/** Роль учётной записи. Определяет доступ, а не принадлежность к клиенту или партнёру. */
export const USER_ROLES = ['admin', 'partner', 'client', 'support'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Состояние учётной записи.
 * `pending` — заведена, но вход ещё не разрешён (не подтверждён адрес, не пройдена модерация).
 * `suspended` — временно закрыт вход, данные сохраняются.
 * `disabled` — закрыта окончательно; удаления нет, на записи ссылается журнал аудита.
 */
export const USER_STATUSES = ['pending', 'active', 'suspended', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Назначение одноразового токена, который уходит человеку письмом
 * ([ADR-0029](../../../docs/adr/0029-pochta.md)).
 *
 * Одна таблица на оба назначения: у них одинаковый жизненный цикл — выдан, использован
 * один раз, протух по сроку, — и две таблицы отличались бы только именем.
 */
export const AUTH_TOKEN_PURPOSES = ['password_reset', 'email_verification'] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

/**
 * Состояние письма в очереди ([ADR-0029](../../../docs/adr/0029-pochta.md)).
 *
 * `failed` — не «письмо потеряно», а «попытки кончились»: строка остаётся с текстом
 * ошибки, и её видно запросом, а не в логах недельной давности.
 */
export const OUTBOX_STATUSES = ['pending', 'sent', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
