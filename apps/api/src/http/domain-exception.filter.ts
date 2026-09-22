/**
 * Единственное место, где доменная ошибка превращается в HTTP-ответ (ADR-0003).
 *
 * Домен не знает о транспорте, поэтому таблица соответствия живёт здесь, а не в сервисах.
 * Наружу уходят только код, безопасное сообщение и идентификатор запроса: стектрейсы,
 * SQL, пути файлов и сообщения зависимостей — никогда.
 */

import { Catch, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { currentCorrelationId } from '@zvonix/logger';
import { toDomainError, toPublicPayload, type DomainError, type ErrorCode } from '@zvonix/shared';
import type { FastifyReply } from 'fastify';
import { APP_LOGGER, type Logger } from '../infra/tokens.js';

/** Таблица из ADR-0003. Новый код ошибки добавляется сначала туда, потом сюда. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  dependency_unavailable: 503,
  internal: 500,
};

/** Обратное соответствие для исключений фреймворка: у них есть статус, но нет кода. */
const CODE_BY_STATUS: Record<number, ErrorCode> = Object.fromEntries(
  Object.entries(STATUS_BY_CODE).map(([code, status]) => [status, code]),
) as Record<number, ErrorCode>;

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger: Logger;

  constructor(@Inject(APP_LOGGER) logger: Logger) {
    this.logger = logger.child('http');
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const correlationId = currentCorrelationId();

    // Тип ответа переставляется на JSON принудительно.
    //
    // Обработчик мог объявить свой — `text/xml` у диалплана и каталога SIP,
    // `text/x-shellscript` у установщика узла. Объявление действует и на ответ
    // с ошибкой, а Fastify отказывается слать объект под чужим типом: «Attempted
    // to send payload of invalid type 'object'». Ошибка при этом превращается
    // в невнятную 500 **поверх** настоящей, и в логе их две.
    //
    // Здесь, а не в каждом обработчике: это свойство ответа об ошибке, а не свойство
    // маршрута, и правило, записанное в одном месте, не забывается на следующем.
    void reply.header('content-type', 'application/json; charset=utf-8');

    // Исключения самого NestJS и Fastify (маршрут не найден, метод не поддержан,
    // тело не разобрано, превышен размер) доменными не являются, но ответ у них
    // должен быть того же вида: клиенту всё равно, где именно внутри нас сломалось.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal' : 'validation_failed');

      if (status >= 500) {
        this.logger.error('Запрос завершился ошибкой', exception, { status });
      }

      void reply.status(status).send({
        error: {
          code,
          // Текст исключения фреймворка при 5xx может содержать внутренние подробности.
          message: status >= 500 ? 'Внутренняя ошибка' : exception.message,
          ...(correlationId === undefined ? {} : { correlation_id: correlationId }),
        },
      });
      return;
    }

    const error = toDomainError(exception);
    const status = STATUS_BY_CODE[error.code];

    // 5xx — наша вина, её пишем как ошибку со всей причиной. 4xx — поведение клиента,
    // на уровне ошибки они забьют лог и скроют настоящие сбои.
    if (status >= 500) {
      this.logger.error('Запрос завершился ошибкой', error, { code: error.code, status });
    } else {
      this.logger.warn('Запрос отклонён', { code: error.code, status, message: error.message });
    }

    // `Retry-After` — часть протокола, а не украшение: клиент, которому не сказали,
    // когда возвращаться, возвращается наугад, то есть создаёт ровно ту нагрузку,
    // из-за которой его и отклонили.
    const retryAfter = retryAfterSeconds(error);
    if (retryAfter !== undefined) void reply.header('Retry-After', String(retryAfter));

    void reply.status(status).send({
      error: {
        ...toPublicPayload(error),
        ...(correlationId === undefined ? {} : { correlation_id: correlationId }),
      },
    });
  }
}

/** Срок ожидания из подробностей ошибки, если он там есть. */
function retryAfterSeconds(error: DomainError): number | undefined {
  const value = error.details?.['retry_after_seconds'];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
