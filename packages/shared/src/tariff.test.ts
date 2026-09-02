/**
 * Тарификация (ADR-0010).
 *
 * Ошибка здесь не падает и не логируется — она просто списывает не ту сумму.
 * Поэтому проверяется таблицей случаев, включая те, что на живых данных встречаются
 * раз в год: минимум, не кратный шагу; ровно на границе шага; нулевая длительность.
 */

import { describe, expect, it } from 'vitest';
import * as Money from './money.js';
import type { Money as MoneyAmount, Rounding } from './money.js';
import {
  billedSeconds,
  chargeForCall,
  maxCharge,
  partnerCost,
  referenceCost,
  REFERENCE_CALL_SECONDS,
  TariffError,
  type CommissionRule,
  type TariffRule,
} from './tariff.js';

const rub = (value: string): MoneyAmount => Money.fromMajorUnits(value);

function rule(overrides: Partial<TariffRule> = {}): TariffRule {
  return {
    pricePerMinute: rub('1.20'),
    billingIncrementSeconds: 1,
    minimumDurationSeconds: 0,
    connectionFee: Money.ZERO,
    rounding: 'half_away_from_zero',
    ...overrides,
  };
}

const noCommission: CommissionRule = { fixedFee: Money.ZERO, percentBasisPoints: 0n };

describe('оплачиваемая длительность', () => {
  it('посекундная тарификация — это шаг, равный единице', () => {
    expect(billedSeconds(37, rule({ billingIncrementSeconds: 1 }))).toBe(37);
  });

  it.each([
    [1, 60],
    [59, 60],
    [60, 60],
    [61, 120],
    [120, 120],
    [121, 180],
  ])('шаг 60: %i секунд → %i', (actual, expected) => {
    expect(billedSeconds(actual, rule({ billingIncrementSeconds: 60 }))).toBe(expected);
  });

  it('минимальная длительность — нижняя граница', () => {
    const r = rule({ minimumDurationSeconds: 30, billingIncrementSeconds: 1 });
    expect(billedSeconds(5, r)).toBe(30);
    expect(billedSeconds(30, r)).toBe(30);
    expect(billedSeconds(31, r)).toBe(31);
  });

  it('минимум — это первый оплачиваемый период целиком, а не округление вверх', () => {
    // Минимум 45, шаг 30. Разговор 50 секунд стоит 45 + 30 = 75, а не 60.
    // Так тарифицируют операторы; другой порядок даёт систематическую ошибку
    // в пользу одной из сторон на каждом коротком вызове.
    const r = rule({ minimumDurationSeconds: 45, billingIncrementSeconds: 30 });
    expect(billedSeconds(10, r)).toBe(45);
    expect(billedSeconds(45, r)).toBe(45);
    expect(billedSeconds(46, r)).toBe(75);
    expect(billedSeconds(75, r)).toBe(75);
    expect(billedSeconds(76, r)).toBe(105);
  });

  it('неотвеченный вызов не тарифицируется, минимум к нему не применяется', () => {
    // Применять минимум не к чему: услуга не оказана.
    expect(billedSeconds(0, rule({ minimumDurationSeconds: 60 }))).toBe(0);
  });

  it.each([
    ['дробная длительность', 1.5],
    ['отрицательная длительность', -1],
  ])('%s отвергается', (_name, value) => {
    expect(() => billedSeconds(value, rule())).toThrow(TariffError);
  });

  it.each([
    ['нулевой шаг', { billingIncrementSeconds: 0 }],
    ['дробный шаг', { billingIncrementSeconds: 2.5 }],
    ['отрицательный минимум', { minimumDurationSeconds: -1 }],
    ['отрицательная цена', { pricePerMinute: rub('-1') }],
  ])('негодное правило (%s) отвергается', (_name, overrides) => {
    expect(() => billedSeconds(60, rule(overrides))).toThrow(TariffError);
  });
});

describe('стоимость для партнёра', () => {
  it('минута по цене минуты', () => {
    expect(Money.format(partnerCost(60, rule({ pricePerMinute: rub('1.20') })))).toBe('1.2');
  });

  it('полминуты — половина цены', () => {
    expect(Money.format(partnerCost(30, rule({ pricePerMinute: rub('1.20') })))).toBe('0.6');
  });

  it('цена считается умножением до деления, а не после', () => {
    // Цена 1 ₽/мин и 1 секунда: 1000000 × 1 / 60 = 16667 микроединиц.
    // «Поделить, потом умножить» дало бы то же, но на 7 секундах и цене 1,5 ₽
    // порядок уже виден, поэтому проверяются оба случая.
    expect(Money.toMicros(partnerCost(1, rule({ pricePerMinute: rub('1') })))).toBe(16667n);
    expect(Money.toMicros(partnerCost(7, rule({ pricePerMinute: rub('1.5') })))).toBe(175000n);
  });

  it('плата за соединение добавляется один раз', () => {
    const r = rule({ pricePerMinute: rub('1.20'), connectionFee: rub('0.50') });
    expect(Money.format(partnerCost(60, r))).toBe('1.7');
    expect(Money.format(partnerCost(120, r))).toBe('2.9');
  });

  it('несостоявшийся вызов не стоит ничего, включая плату за соединение', () => {
    const r = rule({ connectionFee: rub('0.50'), minimumDurationSeconds: 30 });
    expect(Money.isZero(partnerCost(0, r))).toBe(true);
  });

  it('правило округления берётся из тарифа', () => {
    const price = rule({ pricePerMinute: rub('1'), rounding: 'toward_zero' as Rounding });
    // 1000000 / 60 = 16666,67 — вниз даёт 16666, к ближайшему 16667.
    expect(Money.toMicros(partnerCost(1, price))).toBe(16666n);
  });
});

describe('наценка платформы', () => {
  it('фикс и процент применяются вместе, а не по выбору', () => {
    const charge = chargeForCall(60, rule({ pricePerMinute: rub('10') }), {
      fixedFee: rub('0.50'),
      percentBasisPoints: 1500n,
    });

    expect(Money.format(charge.partnerAmount)).toBe('10');
    // 0,50 фикс + 15% от 10 = 1,50 → 2,00
    expect(Money.format(charge.commissionAmount)).toBe('2');
    expect(Money.format(charge.clientAmount)).toBe('12');
  });

  it('клиент платит ровно сумму двух частей', () => {
    const charge = chargeForCall(137, rule({ pricePerMinute: rub('3.33') }), {
      fixedFee: rub('0.17'),
      percentBasisPoints: 733n,
    });

    // Инвариант: третье значение не самостоятельное, а следствие двух первых.
    expect(charge.clientAmount).toBe(Money.add(charge.partnerAmount, charge.commissionAmount));
  });

  it('несостоявшийся вызов не приносит и фиксированной части', () => {
    const charge = chargeForCall(0, rule(), { fixedFee: rub('5'), percentBasisPoints: 1500n });
    expect(charge.billedSeconds).toBe(0);
    expect(Money.isZero(charge.clientAmount)).toBe(true);
    expect(Money.isZero(charge.commissionAmount)).toBe(true);
  });

  it('отрицательная наценка отвергается', () => {
    expect(() =>
      chargeForCall(60, rule(), { fixedFee: rub('-1'), percentBasisPoints: 0n }),
    ).toThrow(TariffError);
    expect(() =>
      chargeForCall(60, rule(), { fixedFee: Money.ZERO, percentBasisPoints: -1n }),
    ).toThrow(TariffError);
  });

  it('нулевая наценка оставляет клиенту цену партнёра', () => {
    const charge = chargeForCall(60, rule({ pricePerMinute: rub('2') }), noCommission);
    expect(charge.clientAmount).toBe(charge.partnerAmount);
  });
});

describe('сумма резерва', () => {
  it('считается как стоимость разговора предельной длительности', () => {
    const r = rule({ pricePerMinute: rub('2'), connectionFee: rub('1') });
    const commission: CommissionRule = { fixedFee: rub('0.50'), percentBasisPoints: 1000n };

    const reserve = maxCharge(3600, r, commission);
    const actual = chargeForCall(3600, r, commission);
    expect(reserve).toEqual(actual);
  });

  it('резерва хватает на любой более короткий разговор', () => {
    const r = rule({ pricePerMinute: rub('2.50'), connectionFee: rub('1') });
    const commission: CommissionRule = { fixedFee: rub('0.50'), percentBasisPoints: 1000n };
    const reserve = maxCharge(600, r, commission);

    // Ради этого свойства резерв и существует: фактическое списание не должно
    // оказаться больше зарезервированного ни при какой длительности.
    for (const seconds of [1, 7, 59, 60, 61, 300, 599, 600]) {
      const actual = chargeForCall(seconds, r, commission);
      expect(Money.compare(actual.clientAmount, reserve.clientAmount)).toBeLessThanOrEqual(0);
    }
  });

  it('нулевая предельная длительность бессмысленна и отвергается', () => {
    expect(() => maxCharge(0, rule(), noCommission)).toThrow(TariffError);
  });
});

describe('стоимость эталонного вызова', () => {
  it('у простого тарифа равна цене за минуту', () => {
    // Ради этого свойства эталон и выбран в минуту: коридор «от 1 до 3» читается
    // администратором как рубли за минуту, а не как отдельная величина.
    expect(referenceCost(rule({ pricePerMinute: rub('2.50') }))).toBe(rub('2.50'));
  });

  it('учитывает плату за соединение', () => {
    // Иначе коридор обходится тарифом «1 рубль за минуту плюс сто за соединение».
    const cost = referenceCost(rule({ pricePerMinute: rub('1'), connectionFee: rub('100') }));
    expect(cost).toBe(rub('101'));
  });

  it('учитывает минимальную длительность', () => {
    // Тариф с минимумом в десять минут делает любой вызов вызовом на десять минут.
    const cost = referenceCost(
      rule({ pricePerMinute: rub('1'), minimumDurationSeconds: 600, billingIncrementSeconds: 60 }),
    );
    expect(cost).toBe(rub('10'));
  });

  it('учитывает шаг тарификации', () => {
    const cost = referenceCost(rule({ pricePerMinute: rub('1'), billingIncrementSeconds: 3600 }));
    expect(cost).toBe(rub('60'));
  });

  it('считается той же функцией, что и настоящий вызов', () => {
    // Отдельная формула «примерно так же» означала бы, что коридор проверяет не то,
    // за что заплатит клиент (ADR-0023).
    const r = rule({ pricePerMinute: rub('3.33'), connectionFee: rub('0.25') });
    expect(referenceCost(r)).toBe(partnerCost(REFERENCE_CALL_SECONDS, r));
  });
});
