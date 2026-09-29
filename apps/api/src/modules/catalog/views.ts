/**
 * Виды тарифных ответов, общие для административного и партнёрского контуров.
 *
 * Общие они не ради экономии строк: цена — одна и та же строка таблицы, и два её
 * представления однажды разошлись бы в округлении или в наборе полей. То же
 * соображение, что и у денежных видов в [billing/views.ts](../billing/views.ts).
 */

import { Money } from '@zvonix/shared';
import type { PartnerRateRow, PartnerTariffRow } from './tariff.repository.js';

/** Тариф партнёра (ADR-0056) — одинаково для партнёра и администратора. */
export interface TariffView {
  readonly id: string;
  readonly name: string;
  readonly is_default: boolean;
}

export function toTariffView(row: PartnerTariffRow): TariffView {
  return { id: row.id, name: row.name, is_default: row.isDefault };
}

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
  /** Тариф цены (ADR-0056); пусто — строка, записанная до тарифов. */
  readonly tariff_id: string | null;
  /** Пусто — цена на все операторы. */
  readonly operator_id: string | null;
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
    tariff_id: row.tariffId,
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
