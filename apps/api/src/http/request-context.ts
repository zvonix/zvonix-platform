/**
 * Доступ к данным запроса в контроллерах.
 */

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { internal } from '@zvonix/shared';
import type { FastifyRequest } from 'fastify';
import type { Principal, RequestMeta } from '../modules/identity/identity.service.js';
import type { MachinePrincipal } from '../modules/machine/machine.service.js';
import type { AuthenticatedRequest } from './auth.guard.js';

/**
 * Вызывающая сторона. Доступен только там, где отработал `AuthGuard`, — то есть везде,
 * кроме помеченного `@Public()`. Отсутствие — не ошибка клиента, а ошибка разметки
 * обработчика, поэтому это внутренняя ошибка, а не 401.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.principal === undefined) {
      throw internal('Обработчик требует вызывающую сторону, но помечен как публичный');
    }
    return request.principal;
  },
);

/**
 * Проверенная машина: узел АТС или клиентская интеграция (ADR-0019).
 *
 * Доступна только в обработчике, помеченном `@Machine()`. Отсутствие означает ошибку
 * разметки обработчика, а не запроса, — поэтому внутренняя ошибка, а не 401.
 */
export const CurrentMachine = createParamDecorator(
  (_data: unknown, context: ExecutionContext): MachinePrincipal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.machine === undefined) {
      throw internal('Обработчик требует машинный ключ, но не помечен @Machine()');
    }
    return request.machine;
  },
);

/**
 * Адрес и клиент, с которых пришёл запрос, — для журнала аудита.
 *
 * `request.ip` уже учитывает `X-Forwarded-For`, но только когда Fastify запущен
 * с `trustProxy`. Без него за обратным прокси в журнал попадёт адрес самого прокси.
 */
export const Meta = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestMeta => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const userAgent = request.headers['user-agent'];
    return {
      ip: request.ip,
      userAgent: userAgent === undefined ? null : userAgent.slice(0, 500),
    };
  },
);
