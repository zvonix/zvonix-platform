'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { UserRole, UserStatus } from '@zvonix/shared';
import { request } from './api';

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
  /** Имя — как отдаёт API. Прежде здесь стояло `fullName`, и имя в углу меню не показывалось никогда. */
  readonly full_name: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly email_confirmed_at: string | null;
  /** Подключён ли второй фактор. */
  readonly totp_enabled?: boolean;
  /** Политика требует подключить второй фактор: до этого доступна только страница «Безопасность». */
  readonly second_factor_required?: boolean;
}

const SESSION_QUERY_KEY = ['auth', 'me'] as const;

/**
 * Кто вошёл.
 *
 * Единственный источник этого ответа — API: сессия лежит в cookie с `HttpOnly`
 * ([ADR-0037](../../../../docs/adr/0037-sessiya-v-brauzere.md)), и прочитать из неё
 * роль на стороне браузера нельзя. Это не неудобство, а свойство: роль, вычитанная
 * из хранилища браузера, — то, что подделывается в консоли за десять секунд.
 *
 * Проверка не повторяется: отказ здесь означает «пора на страницу входа»,
 * а не временную неудачу.
 */
export function useSession(): UseQueryResult<CurrentUser> {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => (await request<{ user: CurrentUser }>('/auth/me')).user,
    retry: false,
    staleTime: 60_000,
  });
}
