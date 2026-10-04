/**
 * Сводки по вызовам и деньгам ([ADR-0059](../../../../../docs/adr/0059-otchyoty-i-svodki.md)).
 *
 * Читающая модель: только `select`. Деньги вызова — из его проводки `charge:<вызов>`
 * (клиент — минус, партнёр — плюс, системный счёт выручки — маржа платформы), отдельных
 * таблиц нет. Модуль читает таблицы трёх модулей одним запросом — сознательное исключение
 * из границ модулей, записанное в ADR.
 */

import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { type Database } from '@zvonix/db';
import type { Id } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

/** Чьи вызовы считаются. */
export type ReportScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'client'; readonly clientId: Id<'client'> }
  | { readonly kind: 'partner'; readonly partnerId: Id<'partner'> };

export const DIMENSIONS = ['client', 'partner', 'operator', 'channel', 'sim', 'gateway'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Метрики группы. Суммы — микроединицы строкой: `bigint` в JSON не ходит. */
export interface Metrics {
  readonly calls: number;
  readonly answered: number;
  readonly talkSeconds: number;
  /** Списано с клиента. */
  readonly clientAmount: string;
  /** Начислено партнёру. */
  readonly partnerAmount: string;
  /** Осталось площадке. */
  readonly margin: string;
}

export interface SeriesRow extends Metrics {
  /** Сутки в часовом поясе запроса, `ГГГГ-ММ-ДД`. */
  readonly day: string;
}

export interface BreakdownRow extends Metrics {
  readonly key: string | null;
  readonly name: string | null;
}

// Псевдоним, а не интерфейс: у интерфейса нет индексной подписи, которой требует `execute`.
type MetricsRow = {
  calls: number;
  answered: number;
  talk_seconds: number;
  client_amount: string;
  partner_amount: string;
  margin: string;
};

const toMetrics = (row: MetricsRow): Metrics => ({
  calls: row.calls,
  answered: row.answered,
  talkSeconds: row.talk_seconds,
  clientAmount: row.client_amount,
  partnerAmount: row.partner_amount,
  margin: row.margin,
});

/** Строка движения по счёту: что произошло, а не только сумма. */
export interface MovementRow {
  readonly at: Date;
  readonly kind: string;
  readonly description: string;
  /** Знак книги: на счёте клиента пополнение положительное, на счёте партнёра выплата отрицательная. */
  readonly amount: string;
}

/** Чей счёт: клиент или партнёр (владелец хранится текстом — он указывает на разные таблицы). */
export type AccountOwner =
  | { readonly kind: 'client'; readonly id: Id<'client'> }
  | { readonly kind: 'partner'; readonly id: Id<'partner'> };

/** Лимит строк разреза: читает человек, полная выгрузка — отдельная задача. */
const BREAKDOWN_LIMIT = 50;

/**
 * Разрез: что считать ключом и названием, откуда их брать.
 * Соединения в базовом запросе левые — вызов без SIM или оператора остаётся в сводке
 * строкой без названия, а не пропадает.
 */
const DIMENSION_SQL: Record<Dimension, { key: SQL; name: SQL }> = {
  client: { key: sql`cl.id::text`, name: sql`cl.name` },
  partner: { key: sql`p.id::text`, name: sql`p.name` },
  operator: { key: sql`o.id::text`, name: sql`o.name` },
  channel: { key: sql`ch.id::text`, name: sql`ch.name` },
  sim: { key: sql`s.id::text`, name: sql`s.msisdn` },
  gateway: { key: sql`g.id::text`, name: sql`g.name` },
};

@Injectable()
export class ReportsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db(): Database {
    return this.database.db;
  }

  /** Суммы по суткам за период. Пустых суток нет — их дополняет служба. */
  async series(
    scope: ReportScope,
    from: Date,
    to: Date,
    offsetMinutes: number,
  ): Promise<SeriesRow[]> {
    const result = await this.db.execute<MetricsRow & { day: string }>(sql`
      with base as (${this.base(scope, from, to)})
      select to_char(date_trunc('day', b.started_at + make_interval(mins => ${offsetMinutes})),
                     'YYYY-MM-DD') as day,
             ${this.metrics()}
        from base b
       group by 1
       order by 1
    `);
    return result.rows.map((row) => ({ day: row.day, ...toMetrics(row) }));
  }

  async breakdown(
    scope: ReportScope,
    from: Date,
    to: Date,
    dimension: Dimension,
  ): Promise<BreakdownRow[]> {
    const { key, name } = DIMENSION_SQL[dimension];
    const result = await this.db.execute<MetricsRow & { key: string | null; name: string | null }>(
      sql`
      with base as (${this.base(scope, from, to)})
      select ${key} as key, ${name} as name, ${this.metrics()}
        from base b
        left join channels ch on ch.id = b.channel_id
        left join clients cl on cl.id = ch.client_id
        left join sim_cards s on s.id = b.sim_card_id
        left join partners p on p.id = s.partner_id
        left join gateways g on g.id = b.gateway_id
        left join operators o on o.id = b.operator_id
       group by 1, 2
       order by sum(b.client_amount) desc nulls last, count(*) desc
       limit ${BREAKDOWN_LIMIT}
    `,
    );
    return result.rows.map((row) => ({ key: row.key, name: row.name, ...toMetrics(row) }));
  }

  /** Остаток счёта на момент `at`: сумма проводок, проведённых раньше. Микроединицы строкой. */
  async balanceAt(owner: AccountOwner, at: Date): Promise<string> {
    const result = await this.db.execute<{ balance: string }>(sql`
      select coalesce(sum(e.amount), 0)::text as balance
        from ledger_entries e
        join ledger_transactions t on t.id = e.transaction_id
        join accounts a on a.id = e.account_id
       where a.kind = ${owner.kind} and a.owner_id = ${owner.id}::text and t.occurred_at < ${at}
    `);
    return result.rows[0]?.balance ?? '0';
  }

  /**
   * Движение по счёту за период: всё, кроме списаний за вызовы, построчно, и сумма самих списаний
   * одной цифрой — вызовы в акте идут своим разделом.
   */
  async movements(
    owner: AccountOwner,
    from: Date,
    to: Date,
  ): Promise<{
    rows: MovementRow[];
    charges: string;
    messageCharges: string;
    messageRefunds: string;
  }> {
    // Списания за сообщения MAX (`message:*`) и возвраты по ним (`message_refund:*`) идут отдельными
    // итогами, а не строками: у отправляющего клиента их тысячи (ADR-0071).
    const found = await this.db.execute<{
      at: Date;
      kind: string;
      description: string;
      amount: string;
    }>(sql`
      select t.occurred_at as at, t.kind, t.description, e.amount::text as amount
        from ledger_entries e
        join ledger_transactions t on t.id = e.transaction_id
        join accounts a on a.id = e.account_id
       where a.kind = ${owner.kind} and a.owner_id = ${owner.id}::text
         and t.occurred_at >= ${from} and t.occurred_at < ${to} and t.kind <> 'charge'
         and t.idempotency_key not like 'message_refund:%'
       order by t.occurred_at, e.seq
    `);
    const totals = await this.db.execute<{
      charges: string;
      message_charges: string;
      message_refunds: string;
    }>(sql`
      select coalesce(sum(e.amount) filter (where t.idempotency_key like 'charge:%'), 0)::text as charges,
             coalesce(sum(e.amount) filter (where t.idempotency_key like 'message:%'), 0)::text as message_charges,
             coalesce(sum(e.amount) filter (where t.idempotency_key like 'message_refund:%'), 0)::text as message_refunds
        from ledger_entries e
        join ledger_transactions t on t.id = e.transaction_id
        join accounts a on a.id = e.account_id
       where a.kind = ${owner.kind} and a.owner_id = ${owner.id}::text
         and t.occurred_at >= ${from} and t.occurred_at < ${to}
    `);
    const row = totals.rows[0];
    return {
      rows: found.rows.map((entry) => ({ ...entry, at: new Date(entry.at) })),
      charges: row?.charges ?? '0',
      messageCharges: row?.message_charges ?? '0',
      messageRefunds: row?.message_refunds ?? '0',
    };
  }

  /** Список метрик группы — общий для суток и разрезов. */
  private metrics(): SQL {
    return sql`
      count(*)::int as calls,
      (count(*) filter (where b.status = 'completed'))::int as answered,
      coalesce(sum(b.duration_seconds) filter (where b.status = 'completed'), 0)::int as talk_seconds,
      coalesce(sum(b.client_amount), 0)::text as client_amount,
      coalesce(sum(b.partner_amount), 0)::text as partner_amount,
      coalesce(sum(b.margin), 0)::text as margin`;
  }

  /**
   * Вызовы периода с деньгами каждого. Проводка находится по ключу идемпотентности
   * (`charge:<вызов>`) — у него уникальный индекс, поиск точечный.
   */
  private base(scope: ReportScope, from: Date, to: Date): SQL {
    const filter =
      scope.kind === 'client'
        ? sql`and c.channel_id in (select id from channels where client_id = ${scope.clientId})`
        : scope.kind === 'partner'
          ? sql`and c.sim_card_id in (select id from sim_cards where partner_id = ${scope.partnerId})`
          : sql``;
    return sql`
      select c.id, c.status, c.duration_seconds, c.started_at, c.operator_id, c.channel_id,
             c.sim_card_id, c.gateway_id, m.client_amount, m.partner_amount, m.margin
        from calls c
        left join lateral (
          select -coalesce(sum(e.amount) filter (where a.kind = 'client'), 0) as client_amount,
                 coalesce(sum(e.amount) filter (where a.kind = 'partner'), 0) as partner_amount,
                 coalesce(sum(e.amount) filter (where a.kind = 'revenue'), 0) as margin
            from ledger_transactions t
            join ledger_entries e on e.transaction_id = t.id
            join accounts a on a.id = e.account_id
           where t.idempotency_key = 'charge:' || c.id::text
        ) m on true
       where c.started_at >= ${from} and c.started_at < ${to} ${filter}`;
  }
}
