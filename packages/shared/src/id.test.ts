import { describe, expect, it } from 'vitest';
import { isId, newId, parseId } from './id.js';
import { isDomainError } from './errors.js';

describe('идентификаторы', () => {
  it('генерирует UUID версии 7', () => {
    const id = newId<'user'>();
    expect(isId(id)).toBe(true);
    // Позиция версии в каноническом представлении: третья группа, первый символ.
    expect(id[14]).toBe('7');
  });

  it('не повторяется', () => {
    const generated = new Set(Array.from({ length: 1000 }, () => newId<'user'>()));
    expect(generated.size).toBe(1000);
  });

  it('монотонен по времени: строки сортируются в порядке создания', () => {
    // Локальность индекса держится именно на этом. Проверяем внутри одной миллисекунды —
    // между миллисекундами порядок задаёт отметка времени и проверять нечего.
    const ids = Array.from({ length: 100 }, () => newId<'user'>());
    expect([...ids].sort()).toEqual(ids);
  });

  it('признаёт корректный UUID и отвергает мусор', () => {
    expect(isId('018f0b3c-0f7a-7c1e-9a2b-3c4d5e6f7a8b')).toBe(true);
    expect(isId('не-uuid')).toBe(false);
    expect(isId('018f0b3c0f7a7c1e9a2b3c4d5e6f7a8b')).toBe(false);
    expect(isId(42)).toBe(false);
    expect(isId(null)).toBe(false);
    expect(isId(undefined)).toBe(false);
  });

  it('разбирает значение и приводит регистр к нижнему', () => {
    expect(parseId('018F0B3C-0F7A-7C1E-9A2B-3C4D5E6F7A8B', 'user')).toBe(
      '018f0b3c-0f7a-7c1e-9a2b-3c4d5e6f7a8b',
    );
  });

  it('на некорректном значении бросает ошибку валидации, а не общее исключение', () => {
    // Идентификатор приходит из параметра запроса, то есть от внешней стороны:
    // это отказ валидации со статусом 4xx, а не внутренняя ошибка.
    try {
      parseId('../../etc/passwd', 'user');
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) {
        expect(error.code).toBe('validation_failed');
        expect(error.details).toEqual({ entity: 'user' });
      }
    }
  });

  it('не раскрывает исходное значение в сообщении', () => {
    // В идентификаторе может оказаться то, что нельзя возвращать в ответе.
    try {
      parseId('секретное-значение', 'user');
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect((error as Error).message).not.toContain('секретное-значение');
    }
  });
});
