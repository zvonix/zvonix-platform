/**
 * Деньги в микроединицах валюты (ADR-0010).
 *
 * 1 рубль = 1 000 000 микроединиц. Всё хранение и все вычисления — целые `bigint`.
 * Плавающая точка не используется нигде, включая разбор ввода и вывод наружу:
 * `number` теряет копейки молча, а в биллинге эта потеря накапливается.
 *
 * Округление выполняется только там, где результат фиксируется как денежная сумма —
 * то есть при расчёте доли от суммы. Промежуточные вычисления остаются точными.
 */

const MICROS_PER_UNIT = 1_000_000n;
const MAX_FRACTION_DIGITS = 6;

declare const moneyBrand: unique symbol;

/** Денежная сумма в микроединицах. Отдельный тип, чтобы её нельзя было спутать с `bigint`. */
export type Money = bigint & { readonly [moneyBrand]: true };

/** Доля в десятитысячных долях: 100% = 10 000, 15% = 1500, 0,5% = 50. */
export type BasisPoints = bigint;

export const BASIS_POINTS_SCALE = 10_000n;

/** Правило округления при получении дробного результата. */
export type Rounding =
  /** К ближайшему, половина — от нуля. Значение по умолчанию для денег. */
  | 'half-away-from-zero'
  /** Отбрасывание дробной части, к нулю. */
  | 'toward-zero';

export class MoneyParseError extends Error {
  override readonly name = 'MoneyParseError';
}

export const ZERO = 0n as Money;

export function fromMicros(micros: bigint): Money {
  return micros as Money;
}

export function toMicros(value: Money): bigint {
  return value;
}

/**
 * Разбирает сумму в основных единицах: `"12.34"` → 12 340 000 микроединиц.
 *
 * Принимает только строку. `number` не принимается сознательно: `0.1 + 0.2` в нём
 * не равно `0.3`, и такая сумма попадёт в биллинг уже искажённой.
 * Дробная часть длиннее шести знаков отвергается, а не отбрасывается молча.
 */
export function fromMajorUnits(value: string): Money {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new MoneyParseError(`Не сумма: ${JSON.stringify(value)}`);
  }
  const [, sign, whole, fraction = ''] = match as unknown as [
    string,
    string,
    string,
    string | undefined,
  ];
  if (fraction.length > MAX_FRACTION_DIGITS) {
    throw new MoneyParseError(
      `Больше ${String(MAX_FRACTION_DIGITS)} знаков после точки — точность будет потеряна: ` +
        JSON.stringify(value),
    );
  }
  const micros =
    BigInt(whole) * MICROS_PER_UNIT + BigInt(fraction.padEnd(MAX_FRACTION_DIGITS, '0'));
  return fromMicros(sign === '-' ? 0n - micros : micros);
}

/**
 * Форматирует сумму в основных единицах: 12 340 000 → `"12.34"`.
 * Незначащие нули дробной части отбрасываются, целая часть остаётся всегда.
 */
export function format(value: Money): string {
  const raw = toMicros(value);
  const negative = raw < 0n;
  const abs = negative ? 0n - raw : raw;
  const whole = abs / MICROS_PER_UNIT;
  const fraction = (abs % MICROS_PER_UNIT).toString().padStart(MAX_FRACTION_DIGITS, '0');
  const trimmed = fraction.replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return trimmed === '' ? `${sign}${whole.toString()}` : `${sign}${whole.toString()}.${trimmed}`;
}

export function add(a: Money, b: Money): Money {
  return fromMicros(a + b);
}

export function subtract(a: Money, b: Money): Money {
  return fromMicros(a - b);
}

export function negate(value: Money): Money {
  return fromMicros(0n - toMicros(value));
}

export function isZero(value: Money): boolean {
  return value === 0n;
}

export function isNegative(value: Money): boolean {
  return value < 0n;
}

/** Умножение на целое: цена за единицу времени на число этих единиц. Точное, без округления. */
export function multiplyByCount(value: Money, count: bigint): Money {
  return fromMicros(value * count);
}

/**
 * Доля от суммы: комиссия платформы, доля партнёра, доля регистратора SIM.
 * Единственное место, где возникает дробный результат, поэтому правило округления
 * задаётся явно.
 */
export function applyBasisPoints(
  value: Money,
  basisPoints: BasisPoints,
  rounding: Rounding = 'half-away-from-zero',
): Money {
  return fromMicros(divideRounded(value * basisPoints, BASIS_POINTS_SCALE, rounding));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function min(a: Money, b: Money): Money {
  return a < b ? a : b;
}

export function max(a: Money, b: Money): Money {
  return a > b ? a : b;
}

/** Сумма списка. Пустой список даёт ноль — это корректная сумма, а не ошибка. */
export function sum(values: readonly Money[]): Money {
  return values.reduce<Money>(add, ZERO);
}

function divideRounded(dividend: bigint, divisor: bigint, rounding: Rounding): bigint {
  const quotient = dividend / divisor;
  if (rounding === 'toward-zero') return quotient;

  const remainder = dividend % divisor;
  if (remainder === 0n) return quotient;

  const twiceRemainder = (remainder < 0n ? 0n - remainder : remainder) * 2n;
  if (twiceRemainder < (divisor < 0n ? 0n - divisor : divisor)) return quotient;

  const negative = dividend < 0n !== divisor < 0n;
  return negative ? quotient - 1n : quotient + 1n;
}
