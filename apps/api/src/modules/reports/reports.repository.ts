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

/** Разрезы вызовов. */
const CALL_DIMENSIONS = ['client', 'partner', 'operator', 'channel', 'sim', 'gateway'] as const;
/**
 * Разрезы сообщений MAX: через что (бот или аккаунты), откуда отправлено (SMPP, API, кабинет), аккаунт партнёра, клиент,
 * партнёр. Сводки были только по вызовам — MAX в них не было вовсе (владелец, 2026-10-23).
 */
const MESSAGE_DIMENSIONS = [
  'message_route',
  'message_channel',
  'message_account',
  'message_client',
  'message_partner',
] as const;
export const DIMENSIONS = [...CALL_DIMENSIONS, ...MESSAGE_DIMENSIONS] as const;
export type Dimension = (typeof DIMENSIONS)[number];
type MessageDimension = (typeof MESSAGE_DIMENSIONS)[number];

const isMessageDimension = (dimension: Dimension): dimension is MessageDimension =>
  (MESSAGE_DIMENSIONS as readonly string[]).includes(dimension);

/** Метрики группы. Суммы — микроединицы строкой: `bigint` в JSON не ходит. */
export interface Metrics {
  readonly calls: number;
  readonly answered: number;
  readonly talkSeconds: number;
  /** Списано с клиента за вызовы. */
  readonly clientAmount: string;
  /** Начислено партнёру за вызовы. */
  readonly partnerAmount: string;
  /** Осталось площадке с вызовов. */
  readonly margin: string;
  /** Сообщений MAX принято к отправке. */
  readonly messages: number;
  /** Из них доставлено или прочитано. */
  readonly messagesDelivered: number;
  /**
   * Из них прочитано. Доля прочитанных — ответ на «доходят ли до нас отметки о прочтении»: без неё нельзя судить о
   * «молчащих» получателях (TASKS 9е).
   */
  readonly messagesRead: number;
  /** За сообщения — за вычетом возвратов за неотправленные: та же книга проводок, `message:*` и `message_refund:*`. */
  readonly messageClientAmount: string;
  readonly messagePartnerAmount: string;
  readonly messageMargin: string;
}

export const EMPTY_METRICS: Metrics = {
  calls: 0,
  answered: 0,
  talkSeconds: 0,
  clientAmount: '0',
  partnerAmount: '0',
  margin: '0',
  messages: 0,
  messagesDelivered: 0,
  messagesRead: 0,
  messageClientAmount: '0',
  messagePartnerAmount: '0',
  messageMargin: '0',
};

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
  ...EMPTY_METRICS,
  calls: row.calls,
  answered: row.answered,
  talkSeconds: row.talk_seconds,
  clientAmount: row.client_amount,
  partnerAmount: row.partner_amount,
  margin: row.margin,
});

type MessageMetricsRow = {
  messages: number;
  delivered: number;
  read: number;
  client_amount: string;
  partner_amount: string;
  margin: string;
};

const toMessageMetrics = (row: MessageMetricsRow): Metrics => ({
  ...EMPTY_METRICS,
  messages: row.messages,
  messagesDelivered: row.delivered,
  messagesRead: row.read,
  messageClientAmount: row.client_amount,
  messagePartnerAmount: row.partner_amount,
  messageMargin: row.margin,
});

/** Сумма микроединиц строкой: складывать деньги числами нельзя. */
const addMicros = (left: string, right: string): string => String(BigInt(left) + BigInt(right));

/** Метрики двух групп в одну: сутки, где были и вызовы, и сообщения. */
export const addMetrics = (left: Metrics, right: Metrics): Metrics => ({
  calls: left.calls + right.calls,
  answered: left.answered + right.answered,
  talkSeconds: left.talkSeconds + right.talkSeconds,
  clientAmount: addMicros(left.clientAmount, right.clientAmount),
  partnerAmount: addMicros(left.partnerAmount, right.partnerAmount),
  margin: addMicros(left.margin, right.margin),
  messages: left.messages + right.messages,
  messagesDelivered: left.messagesDelivered + right.messagesDelivered,
  messagesRead: left.messagesRead + right.messagesRead,
  messageClientAmount: addMicros(left.messageClientAmount, right.messageClientAmount),
  messagePartnerAmount: addMicros(left.messagePartnerAmount, right.messagePartnerAmount),
  messageMargin: addMicros(left.messageMargin, right.messageMargin),
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
const DIMENSION_SQL: Record<(typeof CALL_DIMENSIONS)[number], { key: SQL; name: SQL }> = {
  client: { key: sql`cl.id::text`, name: sql`cl.name` },
  partner: { key: sql`p.id::text`, name: sql`p.name` },
  operator: { key: sql`o.id::text`, name: sql`o.name` },
  channel: { key: sql`ch.id::text`, name: sql`ch.name` },
  sim: { key: sql`s.id::text`, name: sql`s.msisdn` },
  gateway: { key: sql`g.id::text`, name: sql`g.name` },
};

/** Разрезы сообщений: ключ и название. Название маршрута и канала — значение перечисления, словами его называет кабинет. */
const MESSAGE_DIMENSION_SQL: Record<MessageDimension, { key: SQL; name: SQL }> = {
  message_route: { key: sql`b.route`, name: sql`b.route` },
  message_channel: { key: sql`b.channel`, name: sql`b.channel` },
  message_account: { key: sql`ma.id::text`, name: sql`ma.label` },
  message_client: { key: sql`cl.id::text`, name: sql`cl.name` },
  message_partner: { key: sql`p.id::text`, name: sql`p.name` },
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
    const day = (column: SQL): SQL =>
      sql`to_char(date_trunc('day', ${column} + make_interval(mins => ${offsetMinutes})), 'YYYY-MM-DD')`;
    const [calls, messages] = await Promise.all([
      this.db.execute<MetricsRow & { day: string }>(sql`
        with base as (${this.base(scope, from, to)})
        select ${day(sql`b.started_at`)} as day, ${this.metrics()}
          from base b
         group by 1
      `),
      this.db.execute<MessageMetricsRow & { day: string }>(sql`
        with base as (${this.messageBase(scope, from, to)})
        select ${day(sql`b.created_at`)} as day, ${this.messageMetrics()}
          from base b
         group by 1
      `),
    ]);
    const byDay = new Map<string, Metrics>();
    for (const row of calls.rows) byDay.set(row.day, toMetrics(row));
    for (const row of messages.rows) {
      byDay.set(row.day, addMetrics(byDay.get(row.day) ?? EMPTY_METRICS, toMessageMetrics(row)));
    }
    return [...byDay.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, metrics]) => ({ day: key, ...metrics }));
  }

  /**
   * Плата за бота за период — в знаке книги на счёте клиента (минус) либо выручкой площадки (плюс, `all`). Партнёру её нет:
   * она идёт площадке целиком.
   */
  async botFees(scope: ReportScope, from: Date, to: Date): Promise<string> {
    if (scope.kind === 'partner') return '0';
    const owner =
      scope.kind === 'client'
        ? sql`a.kind = 'client' and a.owner_id = ${scope.clientId}::text`
        : sql`a.kind = 'revenue'`;
    const result = await this.db.execute<{ amount: string }>(sql`
      select coalesce(sum(e.amount), 0)::text as amount
        from ledger_entries e
        join ledger_transactions t on t.id = e.transaction_id
        join accounts a on a.id = e.account_id
       where t.idempotency_key like 'bot_fee:%' and ${owner}
         and t.occurred_at >= ${from} and t.occurred_at < ${to}
    `);
    return result.rows[0]?.amount ?? '0';
  }

  async breakdown(
    scope: ReportScope,
    from: Date,
    to: Date,
    dimension: Dimension,
  ): Promise<BreakdownRow[]> {
    if (isMessageDimension(dimension)) return this.messageBreakdown(scope, from, to, dimension);
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
   * Движение по счёту за период: построчно — всё, кроме вызовов и сообщений; они — итогами (у отправляющего клиента их
   * тысячи). Отбор по ключу, а не по виду: плата за бота (`bot_fee:*`) тоже `charge`, и отбор по виду выбрасывал её из
   * акта, а остаток на конец её учитывал — акт не сходился (2026-10-23).
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
         and t.occurred_at >= ${from} and t.occurred_at < ${to}
         and t.idempotency_key not like 'charge:%'
         and t.idempotency_key not like 'message:%'
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

  private async messageBreakdown(
    scope: ReportScope,
    from: Date,
    to: Date,
    dimension: MessageDimension,
  ): Promise<BreakdownRow[]> {
    const { key, name } = MESSAGE_DIMENSION_SQL[dimension];
    const result = await this.db.execute<
      MessageMetricsRow & { key: string | null; name: string | null }
    >(sql`
      with base as (${this.messageBase(scope, from, to)})
      select ${key} as key, ${name} as name, ${this.messageMetrics()}
        from base b
        left join clients cl on cl.id = b.client_id
        left join partners p on p.id = b.partner_id
        left join messenger_accounts ma on ma.id = b.account_id
       group by 1, 2
       order by sum(b.client_amount) desc nulls last, count(*) desc
       limit ${BREAKDOWN_LIMIT}
    `);
    return result.rows.map((row) => ({ key: row.key, name: row.name, ...toMessageMetrics(row) }));
  }

  private messageMetrics(): SQL {
    return sql`
      count(*)::int as messages,
      (count(*) filter (where b.status in ('delivered', 'read')))::int as delivered,
      (count(*) filter (where b.status = 'read'))::int as read,
      coalesce(sum(b.client_amount), 0)::text as client_amount,
      coalesce(sum(b.partner_amount), 0)::text as partner_amount,
      coalesce(sum(b.margin), 0)::text as margin`;
  }

  /**
   * Сообщения периода с деньгами каждого — по книге: списание `message:<id>` и возврат `message_refund:<id>` вместе,
   * поэтому неотправленное с возвратом стоит ноль. Ключи уникальны — поиск точечный.
   */
  private messageBase(scope: ReportScope, from: Date, to: Date): SQL {
    const filter =
      scope.kind === 'client'
        ? sql`and m.client_id = ${scope.clientId}`
        : scope.kind === 'partner'
          ? sql`and m.partner_id = ${scope.partnerId}`
          : sql``;
    return sql`
      select m.id, m.status, m.route, m.channel, m.client_id, m.partner_id, m.account_id, m.created_at,
             x.client_amount, x.partner_amount, x.margin
        from messages m
        left join lateral (
          select -coalesce(sum(e.amount) filter (where a.kind = 'client'), 0) as client_amount,
                 coalesce(sum(e.amount) filter (where a.kind = 'partner'), 0) as partner_amount,
                 coalesce(sum(e.amount) filter (where a.kind = 'revenue'), 0) as margin
            from ledger_transactions t
            join ledger_entries e on e.transaction_id = t.id
            join accounts a on a.id = e.account_id
           where t.idempotency_key in ('message:' || m.id::text, 'message_refund:' || m.id::text)
        ) x on true
       where m.created_at >= ${from} and m.created_at < ${to} ${filter}`;
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
