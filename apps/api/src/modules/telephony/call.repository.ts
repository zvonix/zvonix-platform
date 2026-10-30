/**
 * Запросы к вызовам (ADR-0010, DOMAIN.md).
 */

import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import { toDatabaseError, type Database, type Executor } from '@zvonix/db';
import { calls, channels, gateways, simCards, sipTrunks } from '@zvonix/db/schema';
import {
  newId,
  OPEN_CALL_STATUSES,
  type CallFailureReason,
  type CallStatus,
  type Id,
  type CallDestination,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type CallId = Id<'call'>;

/**
 * Глубже открытый вызов не ищется: дольше `MAX_CALL_DURATION_SECONDS` (не больше четырёх часов) разговор не живёт,
 * а зависший закрывает уборка. Граница держит подсчёт на индексе `(channel_id, started_at)` — без неё он прошёл бы
 * по всей истории линии.
 */
const OPEN_CALL_HORIZON_MS = 86_400_000;

const OPEN_STATUSES_SQL = sql.raw(
  `(${OPEN_CALL_STATUSES.map((value) => `'${value}'`).join(', ')})`,
);

/** Что сейчас происходит на линии: разговоров идёт и когда был последний вызов. */
export interface ChannelActivity {
  readonly open: number;
  readonly lastCallAt: Date | null;
}
/** Попытки номера за скользящие час и сутки и последняя (ADR-0105). */
export interface NumberAttempts {
  readonly hour: number;
  readonly day: number;
  /** Разных абонентов за час и сутки (ADR-0106). */
  readonly distinctHour: number;
  readonly distinctDay: number;
  /** Звонил ли номер спрошенному абоненту за час и сутки. */
  readonly calledHour: boolean;
  readonly calledDay: boolean;
  readonly lastAt: Date | null;
  /** Вызовы, закончившиеся в окне паузы. */
  readonly ended: readonly { readonly id: string; readonly endedAt: Date }[];
}
export type CallRow = typeof calls.$inferSelect;

/** Исполнитель запроса: подключение либо открытая транзакция. */
// Тип объявлен в `@zvonix/db` и переэкспортируется отсюда: вызывающий берёт его
// там же, где метод, а определение остаётся одно на весь проект.
export type { Executor };

/**
 * Отбор вызовов. Пустое поле означает «любой», а не «пустой».
 *
 * Границы периода включающие с обеих сторон: «с 9:00 по 18:00» в разговоре человека
 * означает вместе с восемнадцатью нулями, а не до них.
 */
export interface CallSummaryFilter {
  /**
   * Один вызов по идентификатору.
   *
   * Отбором, а не отдельным методом: «покажи вызов» и «покажи вызовы» отличаются
   * только числом строк, а разрешение имён клиента, оператора и партнёра у них общее.
   * Второй путь чтения означал бы второе место, где о приватности партнёра можно забыть.
   */
  readonly callId?: Id<'call'>;
  readonly status?: CallStatus;
  readonly failureReason?: CallFailureReason;
  readonly clientId?: Id<'client'>;
  readonly channelId?: Id<'channel'>;
  readonly partnerId?: Id<'partner'>;
  /**
   * Номер назначения целиком. Обычно в нормализованном виде — но у отказа
   * `destination_invalid` там цифры набранного, и отбирать по ним тоже надо
   * (ADR-0042).
   */
  readonly destination?: CallDestination;
  readonly from?: Date;
  readonly to?: Date;
}

export interface CallFilter extends CallSummaryFilter {
  readonly limit: number;
  readonly offset: number;
}

/**
 * Вызов вместе с окружением: чей канал и через какое железо ушёл.
 *
 * Названия клиента, оператора и партнёра сюда не попадают — они принадлежат чужим
 * модулям. Здесь только идентификаторы, по которым их разрешает служба.
 */
export interface CallWithContext {
  readonly call: CallRow;
  readonly clientId: Id<'client'>;
  readonly channelName: string;
  readonly gatewayName: string | null;
  readonly partnerId: Id<'partner'> | null;
  readonly simMsisdn: string | null;
}

/** Сколько вызовов пришлось на сочетание «состояние + причина отказа». */
export interface CallTally {
  readonly status: CallStatus;
  readonly failureReason: CallFailureReason | null;
  readonly count: number;
}

function callFilterCondition(filter: CallSummaryFilter): SQL | undefined {
  const parts: SQL[] = [];
  if (filter.callId !== undefined) parts.push(eq(calls.id, filter.callId));
  if (filter.status !== undefined) parts.push(eq(calls.status, filter.status));
  if (filter.failureReason !== undefined) {
    parts.push(eq(calls.failureReason, filter.failureReason));
  }
  if (filter.clientId !== undefined) parts.push(eq(channels.clientId, filter.clientId));
  if (filter.channelId !== undefined) parts.push(eq(calls.channelId, filter.channelId));
  if (filter.partnerId !== undefined) parts.push(eq(gateways.partnerId, filter.partnerId));
  if (filter.destination !== undefined) parts.push(eq(calls.destination, filter.destination));
  if (filter.from !== undefined) parts.push(gte(calls.startedAt, filter.from));
  if (filter.to !== undefined) parts.push(lte(calls.startedAt, filter.to));
  return parts.length === 0 ? undefined : and(...parts);
}

@Injectable()
export class CallRepository {
  constructor(private readonly database: DatabaseService) {}

  get db(): Database {
    return this.database.db;
  }

  async insert(
    draft: {
      externalId: string;
      channelId: Id<'channel'>;
      nodeId: Id<'node'>;
      destination: CallDestination;
      operatorId: Id<'operator'> | null;
      region: string | null;
      simCardId: Id<'simCard'> | null;
      gatewayId: Id<'gateway'> | null;
      /** Строка цены, выбранная маршрутизацией (ADR-0056); у отказа её нет. */
      partnerRateId?: Id<'partnerRate'> | null;
      status: CallStatus;
      failureReason: CallFailureReason | null;
    },
    executor: Executor = this.db,
  ): Promise<CallRow> {
    try {
      const [row] = await executor
        .insert(calls)
        .values({ id: newId<'call'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findById(id: CallId): Promise<CallRow | undefined> {
    const [row] = await this.db.select().from(calls).where(eq(calls.id, id));
    return row;
  }

  async findByExternalId(externalId: string): Promise<CallRow | undefined> {
    const [row] = await this.db.select().from(calls).where(eq(calls.externalId, externalId));
    return row;
  }

  /**
   * Блокирует SIM до конца транзакции.
   *
   * Нужна перед счётом открытых вызовов: без блокировки два одновременных запроса
   * маршрута насчитают одно и то же число и оба решат, что место есть. Блокируется
   * именно SIM, потому что ограничение — на неё: очередь выстраивается только между
   * вызовами на одну карту и никого больше не задерживает.
   */
  async lockSim(simCardId: Id<'simCard'>, executor: Executor): Promise<boolean> {
    const rows = await executor
      .select({ id: simCards.id })
      .from(simCards)
      .where(eq(simCards.id, simCardId))
      .for('update');
    return rows.length === 1;
  }

  /** Сколько вызовов сейчас открыто на этой SIM. */
  async countOpenOnSim(simCardId: Id<'simCard'>, executor: Executor = this.db): Promise<number> {
    const result = await executor.execute<{ count: string }>(sql`
      select count(*)::text as count
        from calls
       where sim_card_id = ${simCardId}
         and status in ${sql.raw(`(${OPEN_CALL_STATUSES.map((value) => `'${value}'`).join(', ')})`)}
    `);
    const row = result.rows[0];
    return row === undefined ? 0 : Number.parseInt(row.count, 10);
  }

  /** Сколько вызовов линии сейчас открыто — для её предела одновременных (ADR-0101, п. 6). */
  async countOpenOnChannel(
    channelId: Id<'channel'>,
    now: Date,
    executor: Executor = this.db,
  ): Promise<number> {
    const result = await executor.execute<{ count: string }>(sql`
      select count(*)::text as count
        from calls
       where channel_id = ${channelId}
         and started_at >= ${new Date(now.getTime() - OPEN_CALL_HORIZON_MS).toISOString()}::timestamptz
         and status in ${OPEN_STATUSES_SQL}
    `);
    const row = result.rows[0];
    return row === undefined ? 0 : Number.parseInt(row.count, 10);
  }

  /**
   * Активность линий для списка: открытые разговоры и последний вызов. Последний — отдельным `limit 1` по индексу
   * на каждую линию: `max` по группе прошёл бы всю историю.
   */
  async channelActivity(
    channelIds: readonly Id<'channel'>[],
    now: Date,
  ): Promise<Map<Id<'channel'>, ChannelActivity>> {
    const activity = new Map<Id<'channel'>, ChannelActivity>();
    if (channelIds.length === 0) return activity;
    const horizon = new Date(now.getTime() - OPEN_CALL_HORIZON_MS).toISOString();
    const result = await this.db.execute<{
      channel_id: string;
      open: string;
      last_call_at: string | Date | null;
    }>(sql`
      select ids.id as channel_id,
             (select count(*) from calls o
               where o.channel_id = ids.id
                 and o.started_at >= ${horizon}::timestamptz
                 and o.status in ${OPEN_STATUSES_SQL})::text as open,
             (select l.started_at from calls l
               where l.channel_id = ids.id
               order by l.started_at desc
               limit 1) as last_call_at
        from unnest(${sql.param([...channelIds])}::uuid[]) as ids(id)
    `);
    for (const row of result.rows) {
      activity.set(row.channel_id as Id<'channel'>, {
        open: Number.parseInt(row.open, 10),
        lastCallAt: row.last_call_at === null ? null : new Date(row.last_call_at),
      });
    }
    return activity;
  }

  /**
   * Попытки номеров — SIM или транков — за скользящие час и сутки
   * ([ADR-0105](../../../../../docs/adr/0105-progrev-i-rekomendovannaya-rabota-nomera.md),
   * [ADR-0106](../../../../../docs/adr/0106-rovnyy-temp-nomera-i-abonenty.md)): сколько попыток и разных абонентов,
   * звонил ли номер абоненту `destination`, последняя попытка и вызовы, закончившиеся позже `restSince` (пауза).
   *
   * Считаются все попытки, ушедшие в сеть, а не отвеченные: оператор видит попытку. Вызов, отклонённый площадкой уже
   * после занятия номера (`failure_reason` заполнен), в сеть не уходил и не считается. Последняя — `limit 1` по
   * индексу, счёт — только за сутки.
   */
  async numberAttempts(
    by: 'sim' | 'gateway',
    ids: readonly string[],
    now: Date,
    options: { readonly destination?: string | undefined; readonly restSince?: Date | undefined },
    executor: Executor = this.db,
  ): Promise<Map<string, NumberAttempts>> {
    const attempts = new Map<string, NumberAttempts>();
    if (ids.length === 0) return attempts;
    const unique = [...new Set(ids)];
    const column = sql.raw(by === 'sim' ? 'sim_card_id' : 'gateway_id');
    const hour = new Date(now.getTime() - 3_600_000).toISOString();
    const day = new Date(now.getTime() - 86_400_000).toISOString();
    const destination = options.destination ?? null;
    const result = await executor.execute<{
      id: string;
      hour: string;
      day: string;
      distinct_hour: string;
      distinct_day: string;
      called_hour: boolean | null;
      called_day: boolean | null;
      last_at: string | Date | null;
    }>(sql`
      select ids.id,
             coalesce(w.hour, 0)::text as hour,
             coalesce(w.day, 0)::text as day,
             coalesce(w.distinct_hour, 0)::text as distinct_hour,
             coalesce(w.distinct_day, 0)::text as distinct_day,
             w.called_hour,
             w.called_day,
             (select l.started_at from calls l
               where l.${column} = ids.id and l.failure_reason is null
               order by l.started_at desc
               limit 1) as last_at
        from unnest(${sql.param(unique)}::uuid[]) as ids(id)
        left join lateral (
          select count(*) filter (where c.started_at > ${hour}::timestamptz) as hour,
                 count(*) as day,
                 count(distinct c.destination) filter (where c.started_at > ${hour}::timestamptz) as distinct_hour,
                 count(distinct c.destination) as distinct_day,
                 bool_or(c.destination = ${destination}::text and c.started_at > ${hour}::timestamptz) as called_hour,
                 bool_or(c.destination = ${destination}::text) as called_day
            from calls c
           where c.${column} = ids.id and c.started_at > ${day}::timestamptz and c.failure_reason is null
        ) w on true
    `);
    const ended = new Map<string, { id: string; endedAt: Date }[]>();
    if (options.restSince !== undefined) {
      // Окончание позже начала: граница по началу держит счёт на индексе (номер, начало). Дольше суток вызов не живёт.
      const since = options.restSince.toISOString();
      const startedSince = new Date(options.restSince.getTime() - 86_400_000).toISOString();
      const rest = await executor.execute<{
        number_id: string;
        id: string;
        ended_at: string | Date;
      }>(sql`
        select c.${column} as number_id, c.id, c.ended_at
          from calls c
         where c.${column} = any(${sql.param(unique)}::uuid[])
           and c.started_at > ${startedSince}::timestamptz
           and c.ended_at > ${since}::timestamptz
           and c.failure_reason is null
      `);
      for (const row of rest.rows) {
        const list = ended.get(row.number_id) ?? [];
        list.push({ id: row.id, endedAt: new Date(row.ended_at) });
        ended.set(row.number_id, list);
      }
    }
    for (const row of result.rows) {
      attempts.set(row.id, {
        hour: Number.parseInt(row.hour, 10),
        day: Number.parseInt(row.day, 10),
        distinctHour: Number.parseInt(row.distinct_hour, 10),
        distinctDay: Number.parseInt(row.distinct_day, 10),
        calledHour: row.called_hour === true,
        calledDay: row.called_day === true,
        lastAt: row.last_at === null ? null : new Date(row.last_at),
        ended: ended.get(row.id) ?? [],
      });
    }
    return attempts;
  }

  /**
   * Сколько раз клиент звонил абоненту за скользящие час и сутки — со всех линий, только ушедшие в сеть
   * ([ADR-0106](../../../../../docs/adr/0106-rovnyy-temp-nomera-i-abonenty.md)). Счёт по индексу (абонент, начало).
   */
  async recipientCalls(
    clientId: Id<'client'>,
    destination: string,
    now: Date,
    executor: Executor = this.db,
  ): Promise<{ hour: number; day: number }> {
    const hour = new Date(now.getTime() - 3_600_000).toISOString();
    const day = new Date(now.getTime() - 86_400_000).toISOString();
    const result = await executor.execute<{ hour: string; day: string }>(sql`
      select (count(*) filter (where c.started_at > ${hour}::timestamptz))::text as hour,
             count(*)::text as day
        from calls c
        join channels ch on ch.id = c.channel_id
       where c.destination = ${destination}
         and c.started_at > ${day}::timestamptz
         and ch.client_id = ${clientId}
         and c.gateway_id is not null
         and c.failure_reason is null
    `);
    const row = result.rows[0];
    return {
      hour: row === undefined ? 0 : Number.parseInt(row.hour, 10),
      day: row === undefined ? 0 : Number.parseInt(row.day, 10),
    };
  }

  /**
   * Запирает пару «клиент, абонент» до конца транзакции: две одновременные заявки одному абоненту иначе насчитали бы
   * одно и то же и прошли обе (ADR-0106).
   */
  async lockRecipient(
    clientId: Id<'client'>,
    destination: string,
    executor: Executor,
  ): Promise<void> {
    await executor.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`recipient:${clientId}:${destination}`}, 0))`,
    );
  }

  /**
   * Блокирует транк до конца транзакции — зеркально `lockSim`.
   *
   * Ёмкость транка договорная: провайдер продаёт каналы и превышение отвергает.
   * Без блокировки два одновременных запроса насчитают одно и то же число свободных
   * каналов и оба решат, что место есть.
   */
  async lockTrunk(gatewayId: Id<'gateway'>, executor: Executor): Promise<boolean> {
    const rows = await executor
      .select({ gatewayId: sipTrunks.gatewayId })
      .from(sipTrunks)
      .where(eq(sipTrunks.gatewayId, gatewayId))
      .for('update');
    return rows.length === 1;
  }

  /**
   * Сколько вызовов сейчас открыто на этом шлюзе.
   *
   * Для транка это и есть занятая ёмкость: SIM у него нет, и считать по ней нечего.
   */
  async countOpenOnGateway(
    gatewayId: Id<'gateway'>,
    executor: Executor = this.db,
  ): Promise<number> {
    const result = await executor.execute<{ count: string }>(sql`
      select count(*)::text as count
        from calls
       where gateway_id = ${gatewayId}
         and status in ${sql.raw(`(${OPEN_CALL_STATUSES.map((value) => `'${value}'`).join(', ')})`)}
    `);
    const row = result.rows[0];
    return row === undefined ? 0 : Number.parseInt(row.count, 10);
  }

  async setStatus(
    id: CallId,
    status: CallStatus,
    patch: {
      failureReason?: CallFailureReason | null;
      answeredAt?: Date | null;
      endedAt?: Date | null;
      durationSeconds?: number | null;
    } = {},
  ): Promise<CallRow | undefined> {
    try {
      const [row] = await this.db
        .update(calls)
        .set({ status, ...patch })
        .where(eq(calls.id, id))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Вызовы по отбору, свежие сверху: по ним разбирают «за что списали»
   * и «почему не звонит».
   *
   * Вместе с вызовом читается его окружение — чей канал, через какое железо ушёл.
   * Список идентификаторов не отвечает ни на один вопрос, ради которого его открывают,
   * а разрешать их построчно означало бы полсотни запросов на страницу.
   *
   * Присоединяются только **свои** таблицы модуля. Названия клиента, оператора
   * и партнёра принадлежат чужим модулям и разрешаются через их интерфейсы
   * (ARCHITECTURE.md, «Границы модулей»).
   */
  async list(filter: CallFilter): Promise<{ rows: CallWithContext[]; total: number }> {
    const condition = callFilterCondition(filter);

    const rows = await this.db
      .select({
        call: calls,
        clientId: channels.clientId,
        channelName: channels.name,
        gatewayName: gateways.name,
        partnerId: gateways.partnerId,
        simMsisdn: simCards.msisdn,
      })
      .from(calls)
      // Канал обязателен у любого вызова, поэтому соединение внутреннее: оно ничего
      // не отсеивает, но избавляет от проверки на пустоту там, где её быть не может.
      .innerJoin(channels, eq(channels.id, calls.channelId))
      // Шлюз и SIM пусты у отказа: выбирать было не из чего, а отказы — половина
      // содержимого этого списка.
      .leftJoin(gateways, eq(gateways.id, calls.gatewayId))
      .leftJoin(simCards, eq(simCards.id, calls.simCardId))
      .where(condition)
      .orderBy(desc(calls.startedAt))
      .limit(filter.limit)
      .offset(filter.offset);

    const [counted] = await this.db
      .select({ total: count() })
      .from(calls)
      .innerJoin(channels, eq(channels.id, calls.channelId))
      .leftJoin(gateways, eq(gateways.id, calls.gatewayId))
      .where(condition);

    return { rows, total: counted?.total ?? 0 };
  }

  /**
   * Сколько вызовов и чем закончились — одним запросом на весь разбор.
   *
   * Отвечает на главный вопрос поддержки: не «покажи вызовы», а «почему не звонит».
   * Считается в базе, а не по выданной странице: страница показывает полсотни строк,
   * а вопрос задан обо всём периоде.
   */
  async summary(filter: CallSummaryFilter): Promise<CallTally[]> {
    return this.db
      .select({
        status: calls.status,
        failureReason: calls.failureReason,
        count: count(),
      })
      .from(calls)
      .innerJoin(channels, eq(channels.id, calls.channelId))
      .leftJoin(gateways, eq(gateways.id, calls.gatewayId))
      .where(callFilterCondition(filter))
      .groupBy(calls.status, calls.failureReason);
  }

  /**
   * Вызов вместе с партнёром, через которого он ушёл.
   *
   * Одним запросом: «прочитать вызов, потом шлюз» — это две проверки владения там,
   * где нужна одна, и промежуток между ними, в который шлюз может сменить хозяина.
   */
  async findWithPartner(
    id: CallId,
  ): Promise<{ call: CallRow; partnerId: Id<'partner'> } | undefined> {
    const [row] = await this.db
      .select({ call: calls, partnerId: gateways.partnerId })
      .from(calls)
      .innerJoin(gateways, eq(gateways.id, calls.gatewayId))
      .where(eq(calls.id, id));
    return row;
  }

  async closeAbandoned(deadline: Date, executor: Executor = this.db): Promise<number> {
    const rows = await executor
      .update(calls)
      .set({ status: 'failed', failureReason: 'node_lost', endedAt: new Date() })
      .where(and(inArray(calls.status, [...OPEN_CALL_STATUSES]), lt(calls.startedAt, deadline)))
      .returning({ id: calls.id });
    return rows.length;
  }
}
