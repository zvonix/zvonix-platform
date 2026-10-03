/**
 * Виды ответов HTTP.
 *
 * Объявлены явно, а не выведены из типов сервиса. Две причины.
 *
 * Первая — контракт: клиенты (службы такси) интегрируются по нему, и изменение
 * внутреннего типа не должно молча менять то, что видит клиент. Правка здесь
 * заметна на ревью, правка в сервисе — нет.
 *
 * Вторая — идентификаторы. Внутри они параметризованы именем сущности,
 * а по проводу это просто строка; типы бренда наружу не выражаются.
 */

import type { UserRole, UserStatus } from '@zvonix/shared';

/**
 * Учётная запись по проводу.
 *
 * Имена полей — `snake_case`, как у всех ответов
 * ([CONVENTIONS.md](../../../../../docs/CONVENTIONS.md)). До 2026-09-07 здесь были
 * `fullName` и `createdAt`: правило есть, а два поля из него выпали, и заметить это
 * можно было только глазами — расхождение вида ответа ничем не проверяется.
 */
export interface UserResponse {
  readonly id: string;
  readonly email: string;
  readonly full_name: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  /** Подтверждён ли адрес: заявитель видит на своём экране, что осталось сделать ему. */
  readonly email_confirmed_at: string | null;
  readonly created_at: string;
  /** Подключён ли у самого человека второй фактор (только в его собственном ответе). */
  readonly totp_enabled?: boolean;
  /** Политика требует подключить второй фактор: пока не подключён, доступны только настройки входа. */
  readonly second_factor_required?: boolean;
}

/**
 * То же плюс то, что нужно администратору в списке.
 *
 * Подтверждён ли адрес, включён ли второй фактор, когда входил в последний раз
 * и не закрыт ли вход блокировкой — четыре вопроса, ради которых на этот список
 * и приходят.
 */
export interface AdminUserResponse extends UserResponse {
  readonly totp_enabled: boolean;
  readonly last_login_at: string | null;
  readonly locked_until: string | null;
}

export interface SessionResponse {
  readonly id: string;
  /** Та сессия, по токену которой пришёл этот запрос. */
  readonly current: boolean;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly created_at: string;
  readonly last_seen_at: string;
  readonly expires_at: string;
}

export interface LoginResponse {
  /** Отдаётся один раз: в базе лежит только его хеш. */
  readonly token: string;
  readonly expires_at: string;
  readonly user: UserResponse;
}
