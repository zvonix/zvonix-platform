import { describe, expect, it } from 'vitest';
import { goipLinePrefix } from './telephony.js';

describe('префикс линии GOIP (ADR-0053)', () => {
  it('порт тремя цифрами после 99', () => {
    expect(goipLinePrefix(1)).toBe('99001');
    expect(goipLinePrefix(32)).toBe('99032');
    expect(goipLinePrefix(256)).toBe('99256');
  });

  it('ни один префикс не начало другого: иначе GOIP выбрал бы не ту линию', () => {
    // С префиксами разной длины `9901` было бы началом `99010`, и порт 10 уходил бы
    // в линию 1. Одинаковая длина исключает это для всех портов разом.
    const prefixes = Array.from({ length: 256 }, (_, index) => goipLinePrefix(index + 1));
    for (const prefix of prefixes) {
      const clashes = prefixes.filter((other) => other !== prefix && other.startsWith(prefix));
      expect(clashes, prefix).toEqual([]);
    }
  });

  it('порта вне 1…999 не бывает — отказ, а не молча кривой префикс', () => {
    expect(() => goipLinePrefix(0)).toThrow(RangeError);
    expect(() => goipLinePrefix(1000)).toThrow(RangeError);
    expect(() => goipLinePrefix(1.5)).toThrow(RangeError);
  });
});
