import { ApiError } from './api';

/** Сколько раз повторить чтение после первой неудачи. */
const MAX_RETRIES = 2;

/**
 * Повторять ли запрос чтения.
 *
 * Повтор — только там, где он что-то даёт. Отказ по правам, по отсутствию объекта
 * или по негодной сессии от повтора не изменится: три одинаковых запроса вместо
 * одного лишь задержат страницу, на которую человеку и так пора.
 *
 * Истёкшее ожидание — тоже без повтора: платформа, не ответившая за 20 с, за следующие
 * 20 с вряд ли ответит, а три попытки держали бы экран в загрузке минуту вместо того,
 * чтобы сказать, что происходит.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.timedOut) return false;
    if (error.status >= 400 && error.status < 500) return false;
  }
  return failureCount < MAX_RETRIES;
}
