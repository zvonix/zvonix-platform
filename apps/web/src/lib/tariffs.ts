'use client';

/**
 * Тарифы партнёра — вид ответа `GET /partner/rates`
 * ([ADR-0056](../../../../docs/adr/0056-tarify-partnyora.md)).
 *
 * Отдельным файлом: тарифы читают и страница «Мои тарифы», и оборудование, где тариф
 * выбирается у шлюза и у карты. Один запрос в кэше на оба экрана.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Rounding, TerminationKind } from '@zvonix/shared';
import { request } from './api';

export interface Tariff {
  readonly id: string;
  readonly name: string;
  readonly is_default: boolean;
}

export interface Rate {
  readonly id: string;
  /** Пусто — строка, записанная до тарифов; читается как цена тарифа по умолчанию. */
  readonly tariff_id: string | null;
  /** Пусто — цена на все операторы. */
  readonly operator_id: string | null;
  readonly operator_name: string | null;
  readonly region: string | null;
  readonly termination_kind: TerminationKind;
  readonly price_per_minute: string;
  readonly billing_increment_seconds: number;
  readonly minimum_duration_seconds: number;
  readonly connection_fee: string;
  readonly rounding: Rounding;
  readonly effective_from: string;
  readonly reference_cost: string;
  readonly band: { readonly min_price: string; readonly max_price: string } | null;
  readonly within_band: boolean;
}

/** Оператор для новой цены и общий коридор по нему, если площадка его задала. */
export interface OperatorChoice {
  readonly operator_id: string;
  readonly operator_name: string;
  readonly min_price: string | null;
  readonly max_price: string | null;
}

export interface PartnerRates {
  readonly reference_call_seconds: number;
  readonly bands_enabled: boolean;
  readonly tariffs: readonly Tariff[];
  readonly rates: readonly Rate[];
  readonly operators_without_price: readonly {
    readonly operator_id: string;
    readonly operator_name: string;
  }[];
  readonly operators: readonly OperatorChoice[];
}

export const PARTNER_RATES_KEY = ['partner', 'rates'] as const;

export function usePartnerRates(): UseQueryResult<PartnerRates> {
  return useQuery({
    queryKey: PARTNER_RATES_KEY,
    queryFn: () => request<PartnerRates>('/partner/rates'),
  });
}

/** Тариф, к которому относится цена: строка без тарифа — цена тарифа по умолчанию. */
export function tariffOfRate(rate: Rate, tariffs: readonly Tariff[]): string | undefined {
  return rate.tariff_id ?? tariffs.find((tariff) => tariff.is_default)?.id;
}
