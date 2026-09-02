/**
 * Тарификация вызова (ADR-0010).
 *
 * Здесь только расчёт: ни базы, ни времени, ни ввода-вывода. Это сделано намеренно —
 * ошибка в тарификации не падает и не логируется, она просто списывает не ту сумму,
 * и обнаруживается на сверке через месяц. Чистая функция проверяется таблицей случаев,
 * включая те, что на живых данных встречаются раз в год.
 *
 * Все суммы — целое число микроединиц (`Money`). Округление выполняется **один раз**,
 * при переводе цены за минуту в цену за фактическую длительность, и правило задаётся
 * тарифом, а не кодом.
 */

import * as Money from './money.js';
import type { BasisPoints, Money as MoneyAmount, Rounding } from './money.js';

/**
 * Правила тарификации, которые задаёт партнёр (DOMAIN.md, `PartnerRate`).
 *
 * Величины длительности — в секундах и целые: доли секунды не тарифицирует никто,
 * а `number` с дробью здесь означал бы, что кто-то пытался.
 */
export interface TariffRule {
  /** Цена за полную минуту разговора. */
  readonly pricePerMinute: MoneyAmount;

  /**
   * Шаг тарификации в секундах: неполный шаг оплачивается как полный.
   * Посекундная тарификация — это шаг, равный единице.
   */
  readonly billingIncrementSeconds: number;

  /**
   * Минимальная оплачиваемая длительность в секундах.
   *
   * Это **первый оплачиваемый период целиком**, а не нижняя граница округления:
   * при минимуме 45 и шаге 30 разговор в 50 секунд стоит 45 + 30 = 75 секунд,
   * а не 60. Так устроена тарификация у операторов, и расхождение здесь означает
   * систематическую ошибку в пользу одной из сторон на каждом коротком вызове.
   */
  readonly minimumDurationSeconds: number;

  /** Плата за соединение. Берётся один раз с отвеченного вызова. */
  readonly connectionFee: MoneyAmount;

  /** Правило округления. Часть тарифа, а не свойство кода (ADR-0010). */
  readonly rounding: Rounding;
}

/**
 * Наценка платформы (DOMAIN.md, `CommissionRule`).
 *
 * Фиксированная часть и процент применяются **вместе**, а не по выбору: фикс покрывает
 * стоимость самого факта вызова, процент — долю от объёма.
 */
export interface CommissionRule {
  /** Фиксированная сумма за вызов. */
  readonly fixedFee: MoneyAmount;
  /** Доля от стоимости партнёра в десятитысячных: 15% = 1500. */
  readonly percentBasisPoints: BasisPoints;
}

/** Из чего сложилась стоимость вызова. В CDR попадает целиком. */
export interface CallCharge {
  /** Оплачиваемая длительность в секундах после применения минимума и шага. */
  readonly billedSeconds: number;
  /** Сколько получает партнёр. */
  readonly partnerAmount: MoneyAmount;
  /** Сколько удерживает платформа. */
  readonly commissionAmount: MoneyAmount;
  /** Сколько платит клиент. Всегда равно сумме двух предыдущих. */
  readonly clientAmount: MoneyAmount;
}

export class TariffError extends Error {
  override readonly name = 'TariffError';
}

function assertRule(rule: TariffRule): void {
  if (!Number.isInteger(rule.billingIncrementSeconds) || rule.billingIncrementSeconds < 1) {
    throw new TariffError('Шаг тарификации должен быть целым числом секунд не меньше единицы');
  }
  if (!Number.isInteger(rule.minimumDurationSeconds) || rule.minimumDurationSeconds < 0) {
    throw new TariffError('Минимальная длительность должна быть целым неотрицательным числом');
  }
  if (Money.isNegative(rule.pricePerMinute) || Money.isNegative(rule.connectionFee)) {
    throw new TariffError('Отрицательная цена или плата за соединение');
  }
}

/**
 * Оплачиваемая длительность.
 *
 * Минимум — первый оплачиваемый период целиком; всё сверх него добирается шагами.
 * Неотвеченный вызов (нулевая длительность) не тарифицируется вовсе: минимум
 * к нему не применяется, потому что применять его не к чему.
 */
export function billedSeconds(actualSeconds: number, rule: TariffRule): number {
  assertRule(rule);
  if (!Number.isInteger(actualSeconds) || actualSeconds < 0) {
    throw new TariffError('Длительность должна быть целым неотрицательным числом секунд');
  }
  if (actualSeconds === 0) return 0;
  if (actualSeconds <= rule.minimumDurationSeconds) return rule.minimumDurationSeconds;

  const beyond = actualSeconds - rule.minimumDurationSeconds;
  const steps = Math.ceil(beyond / rule.billingIncrementSeconds);
  return rule.minimumDurationSeconds + steps * rule.billingIncrementSeconds;
}

const SECONDS_PER_MINUTE = 60n;

/** Стоимость разговора для партнёра: плата за соединение плюс время. */
export function partnerCost(actualSeconds: number, rule: TariffRule): MoneyAmount {
  const seconds = billedSeconds(actualSeconds, rule);
  if (seconds === 0) return Money.ZERO;

  const airtime = Money.prorate(
    rule.pricePerMinute,
    BigInt(seconds),
    SECONDS_PER_MINUTE,
    rule.rounding,
  );
  return Money.add(rule.connectionFee, airtime);
}

/**
 * Полная стоимость вызова: доля партнёра, наценка платформы и сумма для клиента.
 *
 * Клиент платит сумму двух частей — по инварианту DOMAIN.md «клиент платит только
 * за вызовы»: абонплаты и прочих регулярных списаний нет, вся цена здесь.
 */
export function chargeForCall(
  actualSeconds: number,
  rule: TariffRule,
  commission: CommissionRule,
): CallCharge {
  const seconds = billedSeconds(actualSeconds, rule);
  const partnerAmount = partnerCost(actualSeconds, rule);

  if (seconds === 0) {
    // Несостоявшийся вызов не стоит ничего — включая фиксированную часть наценки:
    // брать её не с чего, услуга не оказана.
    return {
      billedSeconds: 0,
      partnerAmount: Money.ZERO,
      commissionAmount: Money.ZERO,
      clientAmount: Money.ZERO,
    };
  }

  if (commission.percentBasisPoints < 0n || Money.isNegative(commission.fixedFee)) {
    throw new TariffError('Отрицательная наценка платформы');
  }

  const commissionAmount = Money.add(
    commission.fixedFee,
    Money.applyBasisPoints(partnerAmount, commission.percentBasisPoints, rule.rounding),
  );

  return {
    billedSeconds: seconds,
    partnerAmount,
    commissionAmount,
    clientAmount: Money.add(partnerAmount, commissionAmount),
  };
}

/**
 * Во сколько обойдётся вызов, если проговорить максимально допустимое время.
 *
 * Ровно эта сумма резервируется **до** начала звонка: инвариант DOMAIN.md «баланс
 * клиента не уходит ниже разрешённого овердрафта» обеспечивается резервированием,
 * а не проверкой после. Сто одновременных вызовов при остатке на одну минуту иначе
 * все прошли бы проверку и все состоялись.
 */
export function maxCharge(
  maxDurationSeconds: number,
  rule: TariffRule,
  commission: CommissionRule,
): CallCharge {
  if (!Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 1) {
    throw new TariffError('Предельная длительность должна быть целым числом секунд');
  }
  return chargeForCall(maxDurationSeconds, rule, commission);
}
