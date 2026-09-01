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

export interface UserResponse {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: Date;
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
