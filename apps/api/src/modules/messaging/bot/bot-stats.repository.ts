/**
 * Статистика бота клиента ([ADR-0099](../../../../../../docs/adr/0099-istoriya-podpischikov-bota.md)): события подписок за период,
 * воронка, сообщения через бота и список подписчиков.
 */

import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { containsIgnoringCase } from '@zvonix/db';
import { botSubscribers } from '@zvonix/db/schema';
import type { BotSubscriberEventKind, BotSubscriberState, Id } from '@zvonix/shared';
import { DatabaseService } from '../../../infra/database.service.js';

export interface BotStatsPeriod {
  readonly clientId: Id<'client'>;
  readonly from: Date;
  readonly to: Date;
  /** Минуты к востоку от UTC — сутки по часам человека. */
  readonly offsetMinutes: number;
}

export interface BotStatsRows {
  readonly events: Record<BotSubscriberEventKind, number>;
  readonly daily: { day: string; kind: BotSubscriberEventKind; n: number }[];
  readonly now: { subscribed: number; withPhone: number };
  readonly funnel: { started: number; shared: number; received: number; stopped: number };
  readonly messages: { total: number; delivered: number; failed: number; cost: bigint };
  readonly failures: { reason: string; n: number }[];
  /** Медиана от первого запуска до номера по поделившимся в периоде, секунд; `null` — никто не поделился. */
  readonly medianSecondsToPhone: number | null;
}

export interface BotSubscriberListRow {
  readonly id: string;
  readonly firstName: string | null;
  readonly phone: string | null;
  readonly state: BotSubscriberState;
  readonly since: Date;
  readonly messages: number;
  readonly lastMessageAt: Date | null;
}

@Injectable()
export class BotStatsRepository {
  constructor(private readonly database: DatabaseService) {}

  async stats(period: BotStatsPeriod): Promise<BotStatsRows> {
    const { clientId, from, to, offsetMinutes } = period;
    const db = this.database.db;
    const [events, daily, now, funnel, messages, failures, median] = await Promise.all([
      db.execute(sql`
        select kind, count(*)::int as n from bot_subscriber_events
         where client_id = ${clientId} and created_at >= ${from} and created_at < ${to}
         group by kind`),
      db.execute(sql`
        select to_char(created_at + make_interval(mins => ${offsetMinutes}), 'YYYY-MM-DD') as day, kind, count(*)::int as n
          from bot_subscriber_events
         where client_id = ${clientId} and created_at >= ${from} and created_at < ${to}
         group by 1, 2
         order by 1`),
      db.execute(sql`
        select (count(*) filter (where state = 'started'))::int as subscribed,
               (count(*) filter (where state = 'started' and phone is not null))::int as with_phone
          from bot_subscribers where client_id = ${clientId}`),
      // Воронка — по тем, кто впервые запустил бота в периоде: что с ними стало к сегодняшнему дню.
      db.execute(sql`
        with cohort as (
          select s.id, s.phone, s.state from bot_subscribers s
           where s.client_id = ${clientId}
             and exists (select 1 from bot_subscriber_events e
                          where e.subscriber_id = s.id and e.kind = 'started'
                            and e.created_at >= ${from} and e.created_at < ${to}))
        select count(*)::int as started,
               (count(*) filter (where phone is not null))::int as shared,
               (count(*) filter (where phone is not null and exists (
                  select 1 from messages m
                   where m.client_id = ${clientId} and m.route = 'bot' and m.recipient = cohort.phone
                     and m.status in ('sent', 'delivered', 'read'))))::int as received,
               (count(*) filter (where state = 'stopped'))::int as stopped
          from cohort`),
      db.execute(sql`
        select count(*)::int as total,
               (count(*) filter (where status in ('delivered', 'read')))::int as delivered,
               (count(*) filter (where status = 'failed'))::int as failed,
               coalesce(sum(client_amount) filter (where status <> 'failed'), 0)::text as cost
          from messages
         where client_id = ${clientId} and route = 'bot' and created_at >= ${from} and created_at < ${to}`),
      db.execute(sql`
        select failure_reason as reason, count(*)::int as n from messages
         where client_id = ${clientId} and route = 'bot' and status = 'failed'
           and created_at >= ${from} and created_at < ${to}
         group by 1 order by 2 desc`),
      db.execute(sql`
        select percentile_cont(0.5) within group (order by extract(epoch from e.created_at - s.created_at)) as median
          from bot_subscriber_events e
          join bot_subscribers s on s.id = e.subscriber_id
         where e.client_id = ${clientId} and e.kind = 'phone_shared'
           and e.created_at >= ${from} and e.created_at < ${to}`),
    ]);

    const byKind: Record<BotSubscriberEventKind, number> = {
      started: 0,
      restarted: 0,
      phone_shared: 0,
      stopped: 0,
    };
    for (const row of events.rows as { kind: BotSubscriberEventKind; n: number }[]) {
      byKind[row.kind] = row.n;
    }
    const nowRow = now.rows[0] as { subscribed: number; with_phone: number } | undefined;
    const funnelRow = funnel.rows[0] as BotStatsRows['funnel'] | undefined;
    const messagesRow = messages.rows[0] as
      { total: number; delivered: number; failed: number; cost: string } | undefined;
    const medianRow = median.rows[0] as { median: number | string | null } | undefined;
    return {
      events: byKind,
      daily: daily.rows as BotStatsRows['daily'],
      now: { subscribed: nowRow?.subscribed ?? 0, withPhone: nowRow?.with_phone ?? 0 },
      funnel: funnelRow ?? { started: 0, shared: 0, received: 0, stopped: 0 },
      messages: {
        total: messagesRow?.total ?? 0,
        delivered: messagesRow?.delivered ?? 0,
        failed: messagesRow?.failed ?? 0,
        cost: BigInt(messagesRow?.cost ?? '0'),
      },
      failures: failures.rows as BotStatsRows['failures'],
      medianSecondsToPhone:
        medianRow?.median === null || medianRow?.median === undefined
          ? null
          : Math.round(Number(medianRow.median)),
    };
  }

  /** Подписчики клиента: новые сверху; `phone` — часть номера; сколько сообщений бот им отправил и когда последнее. */
  async subscribers(filter: {
    clientId: Id<'client'>;
    phone?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<{ rows: BotSubscriberListRow[]; total: number }> {
    const where = and(
      eq(botSubscribers.clientId, filter.clientId),
      filter.phone === undefined
        ? undefined
        : containsIgnoringCase(botSubscribers.phone, filter.phone),
    );
    const sent = sql<number>`(select count(*)::int from messages m
      where m.client_id = ${botSubscribers.clientId} and m.route = 'bot' and m.recipient = ${botSubscribers.phone}
        and m.status in ('sent', 'delivered', 'read'))`;
    const last = sql<Date | null>`(select max(m.created_at) from messages m
      where m.client_id = ${botSubscribers.clientId} and m.route = 'bot' and m.recipient = ${botSubscribers.phone}
        and m.status in ('sent', 'delivered', 'read'))`;
    const rows = await this.database.db
      .select({
        id: botSubscribers.id,
        firstName: botSubscribers.firstName,
        phone: botSubscribers.phone,
        state: botSubscribers.state,
        since: botSubscribers.createdAt,
        messages: sent.mapWith(Number),
        lastMessageAt: last.mapWith((value: string | Date | null) =>
          value === null ? null : new Date(value),
        ),
      })
      .from(botSubscribers)
      .where(where)
      .orderBy(desc(botSubscribers.createdAt), desc(botSubscribers.id))
      .limit(filter.limit)
      .offset(filter.offset);
    const [counted] = await this.database.db
      .select({ total: count() })
      .from(botSubscribers)
      .where(where);
    return { rows, total: counted?.total ?? 0 };
  }
}
