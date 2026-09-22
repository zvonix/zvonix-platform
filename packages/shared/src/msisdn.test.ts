import { describe, expect, it } from 'vitest';
import { isDomainError } from './errors.js';
import {
  defCode,
  dialledDigits,
  fromNumeric,
  isMsisdn,
  normalizeMsisdn,
  parseMsisdn,
  toNumeric,
} from './msisdn.js';

describe('приведение номера к каноническому виду', () => {
  it.each([
    ['+7 913 042-41-23', '79130424123'],
    ['8 (913) 042-41-23', '79130424123'],
    ['79130424123', '79130424123'],
    ['89130424123', '79130424123'],
    ['9130424123', '79130424123'],
    ['+7-913-042-41-23', '79130424123'],
    ['  79130424123  ', '79130424123'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeMsisdn(input)).toBe(expected);
  });

  it('все записи одного номера дают один ключ', () => {
    // Иначе база разрешений наполнится дубликатами, и каждый вариант записи
    // пойдёт во внешний сервис как новый номер.
    const forms = ['+79130424123', '8 913 042 41 23', '9130424123', '7 (913) 0424123'];
    expect(new Set(forms.map(normalizeMsisdn)).size).toBe(1);
  });

  it('восьмёрка в начале — междугородный префикс, а не часть номера', () => {
    // 8800… это тот же префикс плюс DEF-код 800, а не одиннадцатизначный номер,
    // начинающийся с восьмёрки.
    expect(normalizeMsisdn('88001234567')).toBe('78001234567');
    expect(normalizeMsisdn('8001234567')).toBe('78001234567');
  });

  it.each([
    ['', 'пустая строка'],
    ['123', 'слишком короткий'],
    ['791304241234567', 'слишком длинный'],
    ['не номер', 'без цифр'],
    ['19130424123', 'одиннадцать цифр, но не российский'],
  ])('отвергает %s (%s)', (input) => {
    expect(normalizeMsisdn(input)).toBeUndefined();
  });

  it('не проверяет состав DEF-кода', () => {
    // План нумерации меняется, и отказ звонить на валидный номер из-за устаревшей
    // проверки хуже, чем ответ резолвера «оператор не найден».
    expect(normalizeMsisdn('71110424123')).toBe('71110424123');
  });
});

describe('разбор номера из внешних данных', () => {
  it('возвращает канонический вид', () => {
    expect(parseMsisdn('+7 913 042-41-23')).toBe('79130424123');
  });

  it('на негодном значении даёт ошибку валидации', () => {
    try {
      parseMsisdn('не номер');
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) expect(error.code).toBe('validation_failed');
    }
  });

  it('не выносит сам номер в текст ошибки', () => {
    // Номер абонента — персональные данные, а сообщение об ошибке уходит наружу.
    try {
      parseMsisdn('7913042412'); // на цифру короче
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      expect((error as Error).message).not.toContain('7913042412');
    }
  });

  it('сообщает, какое поле не прошло проверку', () => {
    try {
      parseMsisdn('мусор', 'destination');
      expect.unreachable('ожидалась ошибка');
    } catch (error) {
      if (isDomainError(error)) expect(error.details).toEqual({ field: 'destination' });
    }
  });

  it('отвергает значение, которое вообще не строка', () => {
    expect(() => parseMsisdn(79130424123)).toThrow();
    expect(() => parseMsisdn(null)).toThrow();
    expect(() => parseMsisdn(undefined)).toThrow();
  });
});

describe('признак и разбор частей', () => {
  it('признаёт только канонический вид', () => {
    expect(isMsisdn('79130424123')).toBe(true);
    expect(isMsisdn('89130424123')).toBe(false);
    expect(isMsisdn('+79130424123')).toBe(false);
    expect(isMsisdn(79130424123)).toBe(false);
  });

  it('выделяет DEF-код', () => {
    expect(defCode(parseMsisdn('79130424123'))).toBe('913');
    expect(defCode(parseMsisdn('78001234567'))).toBe('800');
  });
});

describe('числовое представление для границ диапазонов', () => {
  it('переводит номер в целое и обратно', () => {
    const msisdn = parseMsisdn('79130424123');
    expect(toNumeric(msisdn)).toBe(79130424123n);
    expect(fromNumeric(79130424123n)).toBe(msisdn);
  });

  it('сохраняет точность на всём диапазоне номеров', () => {
    // На числах с плавающей точкой границы диапазонов сравнивались бы неверно.
    const last = parseMsisdn('79999999999');
    expect(toNumeric(last)).toBe(79999999999n);
    expect(fromNumeric(toNumeric(last))).toBe(last);
  });

  it('отвергает значение, не являющееся российским номером', () => {
    expect(fromNumeric(1234n)).toBeUndefined();
    expect(fromNumeric(89130424123n)).toBeUndefined();
  });

  it('упорядочивает номера так же, как строки внутри одного DEF-кода', () => {
    // На этом держится поиск диапазона: `range_start <= номер <= range_end`.
    const first = toNumeric(parseMsisdn('79130300000'));
    const middle = toNumeric(parseMsisdn('79130424123'));
    const last = toNumeric(parseMsisdn('79130499999'));
    expect(first < middle && middle < last).toBe(true);
  });
});

describe('цифры набранного', () => {
  it('оставляет только цифры: в назначение вызова не должно попадать ничего другого', () => {
    // Оттуда номер уходит в отчёты и в клиентский контур, поэтому `*` и `#` там не нужны.
    expect(dialledDigits('*100#')).toBe('100');
    expect(dialledDigits('112')).toBe('112');
    expect(dialledDigits('+7 (913) 042-41-23')).toBe('79130424123');
  });

  it('не подрезает длину', () => {
    // Обрезка пятнадцатизначного иностранного номера до одиннадцати сделала бы его
    // похожим на российский — это хуже длинной строки (ADR-0042).
    expect(dialledDigits('+1 202 555 0143')).toBe('12025550143');
    expect(dialledDigits('+44 20 7946 0958')).toBe('442079460958');
  });

  it('на наборе без цифр отдаёт пустую строку, а не выдумывает номер', () => {
    expect(dialledDigits('##')).toBe('');
  });
});
