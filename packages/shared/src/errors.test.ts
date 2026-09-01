import { describe, expect, it } from 'vitest';
import {
  conflict,
  DomainError,
  ERROR_CODES,
  internal,
  isDomainError,
  notFound,
  toDomainError,
  toPublicPayload,
  validationFailed,
} from './errors.js';

describe('доменные ошибки', () => {
  it('несут стабильный код', () => {
    expect(notFound('Партнёр не найден').code).toBe('not_found');
    expect(conflict('Цена вне коридора').code).toBe('conflict');
    expect(validationFailed('Неверный номер').code).toBe('validation_failed');
  });

  it('распознаются проверкой типа', () => {
    expect(isDomainError(notFound('нет'))).toBe(true);
    expect(isDomainError(new Error('обычная'))).toBe(false);
    expect(isDomainError('строка')).toBe(false);
    expect(isDomainError(null)).toBe(false);
  });

  it('сохраняют причину для диагностики', () => {
    const cause = new Error('соединение отклонено');
    const error = internal('Не удалось записать CDR', { cause });
    expect(error.cause).toBe(cause);
  });
});

describe('приведение неизвестного значения к доменной ошибке', () => {
  it('пропускает доменную ошибку без изменений', () => {
    const original = notFound('Канал не найден');
    expect(toDomainError(original)).toBe(original);
  });

  it('оборачивает всё остальное, сохраняя причину', () => {
    const raw = new TypeError('undefined is not a function');
    const wrapped = toDomainError(raw);
    expect(wrapped.code).toBe('internal');
    expect(wrapped.cause).toBe(raw);
  });

  it('справляется с тем, что ошибкой не является', () => {
    // В JavaScript бросить можно что угодно, и на границе это надо пережить.
    for (const thrown of ['строка', 42, null, undefined, { что: 'то' }]) {
      const wrapped = toDomainError(thrown);
      expect(wrapped).toBeInstanceOf(DomainError);
      expect(wrapped.code).toBe('internal');
    }
  });
});

describe('представление для внешнего мира', () => {
  it('отдаёт код, сообщение и безопасные подробности', () => {
    const error = validationFailed('Не прошло проверку', { details: { field: 'msisdn' } });
    expect(toPublicPayload(error)).toEqual({
      code: 'validation_failed',
      message: 'Не прошло проверку',
      details: { field: 'msisdn' },
    });
  });

  it('не отдаёт наружу текст внутренней ошибки', () => {
    // Сообщение internal может содержать запрос, путь или имя внешней системы.
    const error = internal('SELECT * FROM partners WHERE inn = ... завершился таймаутом');
    const payload = toPublicPayload(error);
    expect(payload.code).toBe('internal');
    expect(payload.message).toBe('Внутренняя ошибка');
    expect(payload.message).not.toContain('SELECT');
  });

  it('никогда не отдаёт причину и стек', () => {
    const error = internal('сломалось', { cause: new Error('пароль в тексте') });
    const payload = toPublicPayload(error);
    expect(JSON.stringify(payload)).not.toContain('пароль');
    expect(Object.keys(payload).sort()).toEqual(['code', 'message']);
  });

  it('опускает details, когда их нет', () => {
    expect(toPublicPayload(notFound('Нет такого'))).toEqual({
      code: 'not_found',
      message: 'Нет такого',
    });
  });
});

describe('таксономия', () => {
  it('содержит ровно те коды, что описаны в ADR-0003', () => {
    expect([...ERROR_CODES]).toEqual([
      'validation_failed',
      'unauthenticated',
      'permission_denied',
      'not_found',
      'conflict',
      'rate_limited',
      'dependency_unavailable',
      'internal',
    ]);
  });
});
