/**
 * Статистика бота клиента для кабинета и сотрудников ([ADR-0099](../../../../../../docs/adr/0099-istoriya-podpischikov-bota.md)).
 */

import { Injectable } from '@nestjs/common';
import { Money, validationFailed, type BotSubscriberEventKind, type Id } from '@zvonix/shared';
import { BotStatsRepository, type BotSubscriberListRow } from './bot-stats.repository.js';

/** Длиннее периода статистика не строится: по дням это уже не читается, а запрос растёт. */
const MAX_DAYS = 366;
const DAY_MS = 86_400_000;

export interface BotStatsView {
  readonly from: string;
  readonly to: string;
  readonly events: Record<BotSubscriberEventKind, number> & { readonly net: number };
  readonly now: { readonly subscribed: number; readonly with_phone: number };
  readonly funnel: { started: number; shared: number; received: number; stopped: number };
  readonly daily: ({ readonly day: string } & Record<BotSubscriberEventKind, number>)[];
  readonly messages: { total: number; delivered: number; failed: number; cost: string };
  readonly failures: { reason: string; n: number }[];
  readonly median_seconds_to_phone: number | null;
}

export interface BotSubscriberView {
  readonly id: string;
  readonly first_name: string | null;
  readonly phone: string | null;
  readonly state: string;
  readonly since: string;
  readonly messages: number;
  readonly last_message_at: string | null;
}

@Injectable()
export class BotStatsService {
  constructor(private readonly repository: BotStatsRepository) {}

  /** Статистика за период: по умолчанию — последние 7 суток; сутки — по часам человека (`offsetMinutes`). */
  async stats(
    clientId: Id<'client'>,
    query: { from?: string | undefined; to?: string | undefined; offset: number },
    now: Date = new Date(),
  ): Promise<BotStatsView> {
    const to = query.to === undefined ? now : new Date(query.to);
    const from =
      query.from === undefined ? new Date(to.getTime() - 7 * DAY_MS) : new Date(query.from);
    if (from >= to) throw validationFailed('Начало периода должно быть раньше конца');
    if (to.getTime() - from.getTime() > MAX_DAYS * DAY_MS) {
      throw validationFailed(`Период — не длиннее ${String(MAX_DAYS)} суток`);
    }
    const rows = await this.repository.stats({ clientId, from, to, offsetMinutes: query.offset });

    // Пустые сутки — нулями: график без дыр, а «не было ни одного» видно глазом.
    const byDay = new Map<string, Record<BotSubscriberEventKind, number>>();
    for (const day of daysBetween(from, to, query.offset)) {
      byDay.set(day, { started: 0, restarted: 0, phone_shared: 0, stopped: 0 });
    }
    for (const row of rows.daily) {
      const bucket = byDay.get(row.day);
      if (bucket !== undefined) bucket[row.kind] = row.n;
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      events: {
        ...rows.events,
        net: rows.events.started + rows.events.restarted - rows.events.stopped,
      },
      now: { subscribed: rows.now.subscribed, with_phone: rows.now.withPhone },
      funnel: rows.funnel,
      daily: [...byDay].map(([day, counts]) => ({ day, ...counts })),
      messages: { ...rows.messages, cost: Money.format(Money.fromMicros(rows.messages.cost)) },
      failures: rows.failures,
      median_seconds_to_phone: rows.medianSecondsToPhone,
    };
  }

  async subscribers(
    clientId: Id<'client'>,
    query: { phone?: string | undefined; limit: number; offset: number },
  ): Promise<{ subscribers: BotSubscriberView[]; total: number }> {
    const found = await this.repository.subscribers({ clientId, ...query });
    return { total: found.total, subscribers: found.rows.map(toView) };
  }
}

const toView = (row: BotSubscriberListRow): BotSubscriberView => ({
  id: row.id,
  first_name: row.firstName,
  phone: row.phone,
  state: row.state,
  since: row.since.toISOString(),
  messages: row.messages,
  last_message_at: row.lastMessageAt?.toISOString() ?? null,
});

/** Сутки периода по часам человека: `YYYY-MM-DD` от первых до последних. */
function daysBetween(from: Date, to: Date, offsetMinutes: number): string[] {
  const shift = offsetMinutes * 60_000;
  const first = Math.floor((from.getTime() + shift) / DAY_MS);
  const last = Math.floor((to.getTime() - 1 + shift) / DAY_MS);
  const days: string[] = [];
  for (let day = first; day <= last; day += 1) {
    days.push(new Date(day * DAY_MS).toISOString().slice(0, 10));
  }
  return days;
}
