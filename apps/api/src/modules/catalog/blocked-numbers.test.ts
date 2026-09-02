import { parseMsisdn } from '@zvonix/shared';
import { describe, expect, it } from 'vitest';
import { blockingPrefixesOf, MIN_BLOCK_PREFIX_LENGTH } from './blocked-numbers.js';

const msisdn = (value: string) => parseMsisdn(value);

describe('префиксы номера для чёрного списка', () => {
  it('перечисляет все длины от четырёх до полного номера', () => {
    const prefixes = blockingPrefixesOf(msisdn('79130424123'));
    expect(prefixes).toEqual([
      '7913',
      '79130',
      '791304',
      '7913042',
      '79130424',
      '791304241',
      '7913042412',
      '79130424123',
    ]);
  });

  it('последний префикс равен самому номеру', () => {
    // Точный запрет — это префикс длиной одиннадцать, отдельной формы записи нет.
    const number = msisdn('78091234567');
    expect(blockingPrefixesOf(number).at(-1)).toBe(number);
  });

  it('не начинает с длин, запрещающих всю страну', () => {
    // `7` — это вся Россия, `79` — вся мобильная связь. Такое правило завести нельзя,
    // и искать его среди префиксов номера незачем.
    const prefixes = blockingPrefixesOf(msisdn('79130424123'));
    expect(prefixes.every((prefix) => prefix.length >= MIN_BLOCK_PREFIX_LENGTH)).toBe(true);
    expect(prefixes).not.toContain('7');
    expect(prefixes).not.toContain('79');
  });

  it('премиум-номер разбирается так же, как обычный', () => {
    // `8-809-…` после нормализации — обычный одиннадцатизначный `7809…`, и запрет
    // на дорогое направление выражается префиксом `7809`.
    expect(blockingPrefixesOf(msisdn('88091234567'))).toContain('7809');
  });
});
