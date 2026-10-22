/**
 * Наценка площадки на сообщение и обратная задача — какая цена партнёра укладывается в цену для клиента.
 */

import { Money, type CommissionRule, type MoneyAmount } from '@zvonix/shared';

/**
 * Наценка на сообщение: фикс плюс доля от цены партнёра, вместе (ADR-0073). Долю округляем **вверх** до
 * микроединицы (ADR-0010: округляем один раз и в пользу площадки). Правил нет — наценка нулевая.
 */
export function commissionOf(
  partnerAmount: MoneyAmount,
  rule: CommissionRule | undefined,
): MoneyAmount {
  if (rule === undefined) return Money.ZERO;
  const raw = Money.toMicros(partnerAmount) * rule.percentBasisPoints;
  const share = Money.fromMicros((raw + 9_999n) / 10_000n);
  return Money.add(rule.fixedFee, share);
}

/**
 * Самая высокая цена партнёра, при которой цена для клиента (с наценкой) не больше `clientMax`
 * ([ADR-0092](../../../../../docs/adr/0092-trebovaniya-klienta-k-akkauntam.md)). Наценка растёт вместе с ценой, поэтому
 * ответ точный — двоичным поиском по микроединицам, без обратной формулы с её округлением. Не укладывается даже
 * нулевая цена — `undefined`.
 */
export function partnerPriceCap(
  clientMax: MoneyAmount,
  rule: CommissionRule | undefined,
): MoneyAmount | undefined {
  const limit = Money.toMicros(clientMax);
  const clientOf = (micros: bigint): bigint =>
    micros + Money.toMicros(commissionOf(Money.fromMicros(micros), rule));
  if (clientOf(0n) > limit) return undefined;
  let low = 0n;
  let high = limit;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    if (clientOf(middle) <= limit) low = middle;
    else high = middle - 1n;
  }
  return Money.fromMicros(low);
}
