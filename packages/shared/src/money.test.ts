import { describe, expect, it } from 'vitest';
import {
  add,
  applyBasisPoints,
  compare,
  format,
  fromMajorUnits,
  fromMicros,
  MoneyParseError,
  multiplyByCount,
  negate,
  subtract,
  sum,
  toMicros,
  ZERO,
} from './money.js';

describe('разбор суммы', () => {
  it('переводит основные единицы в микроединицы', () => {
    expect(toMicros(fromMajorUnits('12.34'))).toBe(12_340_000n);
    expect(toMicros(fromMajorUnits('0.000001'))).toBe(1n);
    expect(toMicros(fromMajorUnits('1'))).toBe(1_000_000n);
    expect(toMicros(fromMajorUnits('-5.5'))).toBe(-5_500_000n);
  });

  it('не теряет точность там, где её теряет число с плавающей точкой', () => {
    const total = add(fromMajorUnits('0.1'), fromMajorUnits('0.2'));
    expect(format(total)).toBe('0.3');
    expect(toMicros(total)).toBe(toMicros(fromMajorUnits('0.3')));
  });

  it('отвергает лишние знаки вместо молчаливого отбрасывания', () => {
    expect(() => fromMajorUnits('1.1234567')).toThrow(MoneyParseError);
  });

  it('отвергает то, что суммой не является', () => {
    for (const bad of ['', ' ', '1,5', '1.2.3', 'abc', '1e6', '+1', '.5']) {
      expect(() => fromMajorUnits(bad), bad).toThrow(MoneyParseError);
    }
  });
});

describe('форматирование', () => {
  it('отбрасывает незначащие нули, но сохраняет целую часть', () => {
    expect(format(fromMicros(12_340_000n))).toBe('12.34');
    expect(format(fromMicros(1_000_000n))).toBe('1');
    expect(format(ZERO)).toBe('0');
    expect(format(fromMicros(1n))).toBe('0.000001');
    expect(format(fromMicros(-5_500_000n))).toBe('-5.5');
  });

  it('обратим с разбором', () => {
    for (const value of ['0', '1', '12.34', '-0.5', '999999.999999']) {
      expect(format(fromMajorUnits(value))).toBe(value);
    }
  });
});

describe('арифметика', () => {
  it('складывает, вычитает и меняет знак', () => {
    const a = fromMajorUnits('10');
    const b = fromMajorUnits('3.5');
    expect(format(add(a, b))).toBe('13.5');
    expect(format(subtract(a, b))).toBe('6.5');
    expect(format(negate(b))).toBe('-3.5');
  });

  it('умножает на целое количество без округления', () => {
    const perMinute = fromMajorUnits('1.37');
    expect(format(multiplyByCount(perMinute, 60n))).toBe('82.2');
  });

  it('суммирует список, пустой даёт ноль', () => {
    expect(format(sum([]))).toBe('0');
    expect(format(sum([fromMajorUnits('1.1'), fromMajorUnits('2.2'), fromMajorUnits('3.3')]))).toBe(
      '6.6',
    );
  });

  it('сравнивает', () => {
    expect(compare(fromMajorUnits('1'), fromMajorUnits('2'))).toBe(-1);
    expect(compare(fromMajorUnits('2'), fromMajorUnits('1'))).toBe(1);
    expect(compare(fromMajorUnits('1'), fromMajorUnits('1'))).toBe(0);
  });
});

describe('доля от суммы', () => {
  it('считает процент', () => {
    // 15% от 100 рублей
    expect(format(applyBasisPoints(fromMajorUnits('100'), 1500n))).toBe('15');
  });

  it('округляет половину от нуля', () => {
    // 1 микроединица, делённая пополам, — ровно половина
    expect(toMicros(applyBasisPoints(fromMicros(1n), 5000n))).toBe(1n);
    expect(toMicros(applyBasisPoints(fromMicros(-1n), 5000n))).toBe(-1n);
  });

  it('отбрасывает дробь при явном указании', () => {
    expect(toMicros(applyBasisPoints(fromMicros(1n), 5000n, 'toward-zero'))).toBe(0n);
    expect(toMicros(applyBasisPoints(fromMicros(-1n), 5000n, 'toward-zero'))).toBe(0n);
  });

  it('доля и остаток в сумме дают исходную сумму', () => {
    // Инвариант расчёта: комиссия платформы плюс доля партнёра равны стоимости вызова.
    const total = fromMajorUnits('37.77');
    const commission = applyBasisPoints(total, 1500n);
    const partnerShare = subtract(total, commission);
    expect(toMicros(add(commission, partnerShare))).toBe(toMicros(total));
  });
});
