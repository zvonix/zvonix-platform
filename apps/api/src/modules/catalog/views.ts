/**
 * Виды тарифных ответов, общие для административного и партнёрского контуров.
 *
 * Общие они не ради экономии строк: цена — одна и та же строка таблицы, и два её
 * представления однажды разошлись бы в округлении или в наборе полей. То же
 * соображение, что и у денежных видов в [billing/views.ts](../billing/views.ts).
 */

import { Money } from '@zvonix/shared';
import type { PartnerRateRow } from './tariff.repository.js';

/**
 * Цена партнёра по направлению — как её отдают человеку.
 *
 * Все пять чисел тарифа целиком: цена за минуту, шаг, минимум, плата за соединение
 * и правило округления. Половина тарифа наружу — приглашение достроить недостающее
 * у себя и посчитать не то, за что заплатит клиент ([ADR-0023](../../../../../docs/adr/0023-koridory-cen.md)).
 */
export interface RateView {
  readonly id: string;
  readonly partner_id: string;
  readonly operator_id: string;
  readonly termination_kind: string;
  readonly region: string | null;
  readonly price_per_minute: string;
  readonly billing_increment_seconds: number;
  readonly minimum_duration_seconds: number;
  readonly connection_fee: string;
  readonly rounding: string;
  readonly effective_from: string;
}

export function toRateView(row: PartnerRateRow): RateView {
  return {
    id: row.id,
    partner_id: row.partnerId,
    operator_id: row.operatorId,
    termination_kind: row.terminationKind,
    region: row.region,
    price_per_minute: Money.format(row.pricePerMinute),
    billing_increment_seconds: row.billingIncrementSeconds,
    minimum_duration_seconds: row.minimumDurationSeconds,
    connection_fee: Money.format(row.connectionFee),
    rounding: row.rounding,
    effective_from: row.effectiveFrom.toISOString(),
  };
}
