/**
 * Сквозной идентификатор запроса (ADR-0004).
 *
 * Ставится хуком Fastify на самом входе, до маршрутизации: тогда в контексте окажется
 * и обработка запроса, который не дошёл до контроллера, — а именно такие и разбирают.
 *
 * Используется `enterCorrelationId`, а не обёртка `runWithCorrelationId`: хук помечает
 * запрос и завершается, а обработчик будет вызван Fastify позже и обернуть его нечем.
 *
 * Идентификатор от клиента принимается, чтобы цепочка не рвалась на границе систем,
 * но не доверяется как есть: чужая строка попадёт в наши логи и в журнал аудита,
 * поэтому длина и состав символов ограничены.
 */

import { enterCorrelationId } from '@zvonix/logger';
import type { FastifyInstance } from 'fastify';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

const ACCEPTABLE = /^[A-Za-z0-9._-]{8,128}$/;

function fromHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw !== undefined && ACCEPTABLE.test(raw) ? raw : undefined;
}

export function registerCorrelationId(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    const correlationId = enterCorrelationId(fromHeader(request.headers[CORRELATION_ID_HEADER]));
    // Возвращаем клиенту: без этого он не может сослаться на конкретный запрос
    // в обращении в поддержку, а мы — найти его в логах.
    void reply.header(CORRELATION_ID_HEADER, correlationId);
    done();
  });
}
