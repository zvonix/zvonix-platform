/**
 * Разбор входных данных схемой zod.
 *
 * Схемы лежат рядом с модулем и переиспользуются фронтендом (ADR-0008), поэтому
 * валидация идёт ими, а не декораторами class-validator: иначе правила пришлось бы
 * описать дважды и следить за расхождением руками.
 */

import { type PipeTransform } from '@nestjs/common';
import { validationFailed } from '@zvonix/shared';
import type { ZodType } from 'zod';

/**
 * Собирает подробности отказа в вид, который безопасно отдать клиенту:
 * путь до поля и причина, без самого значения.
 *
 * Значение не показывается намеренно — в теле запроса лежат пароли и номера абонентов,
 * а сообщение об ошибке уходит наружу и попадает в чужие логи.
 */
function describe(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.map((part) => String(part)).join('.');
    return field === '' ? issue.message : `${field}: ${issue.message}`;
  });
}

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw validationFailed('Данные запроса не прошли проверку', {
      details: { problems: describe(result.error) },
    });
  }
}

/** Короткая запись для параметра контроллера: `@Body(zodBody(schema))`. */
export function zodBody<T>(schema: ZodType<T>): ZodPipe<T> {
  return new ZodPipe(schema);
}

/**
 * То же для строки запроса: `@Query(zodQuery(schema))`.
 *
 * Отдельное имя, а не тот же `zodBody`: у строки запроса все значения — строки,
 * и схема обязана приводить их сама. Читающий вызов должен видеть, что здесь
 * разбирается адрес, а не тело.
 */
export function zodQuery<T>(schema: ZodType<T>): ZodPipe<T> {
  return new ZodPipe(schema);
}
