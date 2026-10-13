import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { ApiError } from './api';
import { SESSION_QUERY_KEY } from './session';

/**
 * Любой запрос получил «требуется вход» — сессия кончилась, пока на экране ещё стоит оболочка
 * с меню и именем пользователя.
 *
 * Оболочка судит о сессии по собственному запросу, который считается свежим минуту, и не знает
 * о чужом отказе: человек видел меню и «Требуется вход» посреди страницы. Перечитывание сессии
 * даёт ей тот же отказ, и оболочка сама уводит на вход вместо пустой страницы с меню.
 *
 * Сам запрос сессии исключён: его отказ — это и есть сигнал, повтор зациклил бы его.
 */
export function onSessionLost(
  client: Pick<QueryClient, 'invalidateQueries'>,
  error: unknown,
  queryKey?: QueryKey,
): void {
  if (!(error instanceof ApiError) || !error.needsLogin) return;
  if (queryKey !== undefined && queryKey.join('/') === SESSION_QUERY_KEY.join('/')) return;
  void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
}
