/**
 * Виды лимитов — общие для администратора и партнёра
 * ([ADR-0057](../../../../../docs/adr/0057-limity-partnyora.md)): одно правило не должно
 * читаться у двух сторон по-разному.
 */

import type { LimitMetric, LimitRounding, LimitSetBy, LimitWindow } from '@zvonix/shared';
import type { LimitRuleRow } from './limit.repository.js';
import type { LimitUsage } from './limit.service.js';

export interface LimitView {
  readonly id: string;
  readonly client_id: string | null;
  readonly channel_id: string | null;
  readonly partner_id: string | null;
  readonly sim_card_id: string | null;
  readonly window: LimitWindow;
  readonly metric: LimitMetric;
  readonly value: number;
  /** Правило партнёра считается у каждой его SIM отдельно. */
  readonly per_sim: boolean;
  /** Как разговор идёт в счётчик минут: посекундно или с округлением до минуты. */
  readonly rounding: LimitRounding;
  /** День обновления месячного окна; пусто — первое число. */
  readonly period_start_day: number | null;
  readonly set_by: LimitSetBy;
}

/**
 * Лимит вместе с израсходованным.
 *
 * `used` и `limit` — в единицах хранения: звонки штуками, минуты секундами. У правила
 * «на каждую карту» строк столько, сколько карт, и `usage_sim_card_id` называет карту.
 * `resets_at` — когда окно закончится: окна считаются в UTC, а человеку нужен момент.
 */
export interface LimitUsageView extends LimitView {
  readonly usage_sim_card_id: string | null;
  readonly bucket_start: string;
  readonly resets_at: string;
  readonly used: number;
  readonly limit: number;
  readonly exceeded: boolean;
}

export function toLimitView(row: LimitRuleRow): LimitView {
  return {
    id: row.id,
    client_id: row.clientId,
    channel_id: row.channelId,
    partner_id: row.partnerId,
    sim_card_id: row.simCardId,
    window: row.window,
    metric: row.metric,
    value: row.value,
    per_sim: row.perSim,
    rounding: row.rounding,
    period_start_day: row.periodStartDay,
    set_by: row.setBy,
  };
}

export function toUsageView(usage: LimitUsage): LimitUsageView {
  return {
    ...toLimitView(usage.rule),
    usage_sim_card_id: usage.simCardId,
    bucket_start: usage.bucketStart.toISOString(),
    resets_at: usage.resetsAt.toISOString(),
    used: usage.used,
    limit: usage.limit,
    exceeded: usage.exceeded,
  };
}
