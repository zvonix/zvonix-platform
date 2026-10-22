/**
 * Журнал медленных запросов.
 *
 * Кабинет обрывает ожидание через 20 секунд («Платформа не ответила за 20 с»), а по логам до сих пор нельзя было сказать,
 * какой запрос тянулся и сколько (владелец, 2026-10-22). Запрос дольше порога пишется предупреждением: метод, **шаблон**
 * маршрута (`/client/messages/:id`, а не адрес с номером — номера абонентов в логи не попадают), код ответа и время.
 * Сквозной идентификатор добавляет логгер сам (ADR-0004).
 */

import type { Logger } from '@zvonix/logger';
import type { FastifyInstance } from 'fastify';

/** Дольше этого запрос считается медленным: кабинет ждёт 20 с, и задолго до них человек видит «зависание». */
const SLOW_REQUEST_MS = 2_000;

export function registerSlowRequestLog(
  fastify: FastifyInstance,
  logger: Logger,
  thresholdMs: number = SLOW_REQUEST_MS,
): void {
  const log = logger.child('http');
  fastify.addHook('onResponse', (request, reply, done) => {
    const elapsed = reply.elapsedTime;
    if (elapsed >= thresholdMs) {
      log.warn('Медленный запрос', {
        method: request.method,
        route: request.routeOptions.url ?? 'неизвестный маршрут',
        status: reply.statusCode,
        duration_ms: Math.round(elapsed),
      });
    }
    done();
  });
}
