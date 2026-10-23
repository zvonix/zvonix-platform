/**
 * Сообщения MAX: очередь и журнал ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)).
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  min,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { toDatabaseError, type Executor } from '@zvonix/db';
import {
  messageRefusals,
  messages,
  messengerAccountEvents,
  messengerAccounts,
  numberChecks,
  partnerDistributions,
  smppAccounts,
} from '@zvonix/db/schema';
import {
  newId,
  type Id,
  type MessageChannel,
  type MessageFailureReason,
  type MessageRoute,
  type MessageStatus,
  type MoneyAmount,
  type NumberCheckResult,
  type SmppReceiptEvent,
  type SmppReceiptMap,
  WARMUP_IDLE_DAYS,
} from '@zvonix/shared';
import type { ClientRules } from './requirements.service.js';
import { DatabaseService } from '../../infra/database.service.js';
import type { MessengerAccountRow } from './messaging.repository.js';

export type MessageRow = typeof messages.$inferSelect;
export type MessageId = Id<'message'>;

/** Нагрузка на аккаунт: отправки за минуту, час, сутки и очередь, которая за ним стоит. */
/** Счётчики отчёта: одни и те же по клиенту и по аккаунту. */
interface ReportCounts {
  readonly total: number;
  readonly sent: number;
  readonly delivered: number;
  readonly read: number;
  readonly failed: number;
  readonly not_in_max: number;
  readonly account_unavailable: number;
  readonly wait_expired: number;
  readonly provider_timeout: number;
  readonly platform: number;
  readonly recipient_stopped: number;
  /** Ушли через аккаунты и лежат дольше суток, ушедшие успешно; из них прочитанные — `settled_read`. */
  readonly settled: number;
  readonly settled_read: number;
}

export interface ClientReportRow extends ReportCounts {
  readonly clientId: Id<'client'>;
  readonly name: string;
}

export interface AccountReportRow extends ReportCounts {
  readonly accountId: Id<'messengerAccount'>;
  readonly label: string;
  readonly partnerName: string;
  readonly status: string;
  readonly stateReason: string | null;
  readonly pausedUntil: string | null;
  readonly pauseReason: string | null;
}

/** Журнал аккаунта за окно: проверки номеров и события состояния (ADR-0088). */
export interface AccountJournalRow {
  readonly accountId: Id<'messengerAccount'>;
  readonly label: string;
  readonly partnerName: string;
  readonly status: string;
  readonly checks_exists: number;
  readonly checks_absent: number;
  readonly checks_unknown: number;
  readonly checks_limited: number;
  readonly blocked: number;
  readonly suspended: number;
  readonly logged_out: number;
  readonly health_paused: number;
}

export interface AccountEventRow {
  readonly accountId: Id<'messengerAccount'>;
  readonly label: string;
  readonly kind: string;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface AccountLoad {
  minute: number;
  hour: number;
  day: number;
  backlog: number;
}

/** Сколько «взятое в работу» считается живым: дольше — воркер умер, сообщение берут заново. */
const LEASE_MS = 5 * 60_000;

export interface MessageFilter {
  readonly clientId?: Id<'client'>;
  readonly partnerId?: Id<'partner'>;
  readonly status?: MessageStatus;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  readonly offset: number;
}

/** Бот или аккаунты по клиенту (ADR-0094). */
export interface RouteStatsRow {
  readonly clientId: string;
  readonly name: string;
  /** Разные номера, которым ушло хоть одно сообщение. */
  readonly recipients: number;
  /** Из них сейчас подписаны на бота клиента. */
  readonly inBot: number;
  readonly viaBot: number;
  readonly viaAccounts: number;
}

@Injectable()
export class MessagesRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Новое сообщение — внутри транзакции списания: нет денег — нет и строки. */
  async insert(
    draft: {
      id: MessageId;
      clientId: Id<'client'>;
      externalId: string | null;
      channel: MessageChannel;
      recipient: string;
      text: string;
      route?: MessageRoute;
      /** Аккаунт и партнёр — у сообщения аккаунта; бот — у сообщения бота (ADR-0077). */
      accountId?: Id<'messengerAccount'>;
      partnerId?: Id<'partner'>;
      botId?: Id<'messengerBot'>;
      clientAmount: MoneyAmount;
      partnerAmount: MoneyAmount;
      commissionAmount: MoneyAmount;
      /** Не ушло к этому моменту — отказ с возвратом (ADR-0097). */
      expiresAt?: Date;
    },
    executor: Executor = this.database.db,
  ): Promise<MessageRow> {
    try {
      const [row] = await executor.insert(messages).values(draft).returning();
      if (row === undefined) throw new Error('Сообщение не вставлено');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  newId(): MessageId {
    return newId<'message'>();
  }

  async findById(id: MessageId): Promise<MessageRow | undefined> {
    const [row] = await this.database.db.select().from(messages).where(eq(messages.id, id));
    return row;
  }

  /**
   * Уходило ли этому номеру от этого клиента что-то ещё (кроме самого сообщения): по нему шаблон решает, первое ли это
   * сообщение человеку (ADR-0087). Считается ушедшим всё, что дошло до мессенджера.
   */
  async hasEarlierSent(
    clientId: Id<'client'>,
    recipient: string,
    exceptId: MessageId,
    route: MessageRoute,
  ): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.clientId, clientId),
          eq(messages.recipient, recipient),
          eq(messages.route, route),
          ne(messages.id, exceptId),
          inArray(messages.status, ['sent', 'delivered', 'read']),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async findByExternal(
    clientId: Id<'client'>,
    externalId: string,
  ): Promise<MessageRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(messages)
      .where(and(eq(messages.clientId, clientId), eq(messages.externalId, externalId)));
    return row;
  }

  /**
   * Журнал вместе с отклонёнными при приёме (ADR-0098): одна страница по времени из двух таблиц. Возвращает порядок — вид и
   * идентификатор; строки дочитывает вызывающий. Отбор по итогу сюда не приходит: у отклонённого его нет.
   */
  async journalWithRefusals(
    filter: Omit<MessageFilter, 'status' | 'partnerId'>,
    onlyRefused: boolean,
  ): Promise<{ page: { kind: 'message' | 'refused'; id: string }[]; total: number }> {
    const refusalsWhere = and(
      filter.clientId === undefined ? undefined : eq(messageRefusals.clientId, filter.clientId),
      filter.from === undefined ? undefined : gte(messageRefusals.createdAt, filter.from),
      filter.to === undefined ? undefined : lt(messageRefusals.createdAt, filter.to),
    );
    const refused = this.database.db
      .select({
        id: sql<string>`${messageRefusals.id}::text`.as('id'),
        at: sql<Date>`${messageRefusals.createdAt}`.mapWith(messageRefusals.createdAt).as('at'),
        kind: sql<'message' | 'refused'>`'refused'`.as('kind'),
      })
      .from(messageRefusals)
      .where(refusalsWhere);
    const [refusedCount] = await this.database.db
      .select({ total: count() })
      .from(messageRefusals)
      .where(refusalsWhere);
    if (onlyRefused) {
      const page = await refused
        .orderBy(sql`at desc`, sql`id desc`)
        .limit(filter.limit)
        .offset(filter.offset);
      return { page, total: refusedCount?.total ?? 0 };
    }
    const messagesWhere = and(
      filter.clientId === undefined ? undefined : eq(messages.clientId, filter.clientId),
      filter.from === undefined ? undefined : gte(messages.createdAt, filter.from),
      filter.to === undefined ? undefined : lt(messages.createdAt, filter.to),
    );
    const page = await this.database.db
      .select({
        id: sql<string>`${messages.id}::text`.as('id'),
        at: sql<Date>`${messages.createdAt}`.mapWith(messages.createdAt).as('at'),
        kind: sql<'message' | 'refused'>`'message'`.as('kind'),
      })
      .from(messages)
      .where(messagesWhere)
      .unionAll(refused)
      .orderBy(sql`at desc`, sql`id desc`)
      .limit(filter.limit)
      .offset(filter.offset);
    const [messagesCount] = await this.database.db
      .select({ total: count() })
      .from(messages)
      .where(messagesWhere);
    return { page, total: (messagesCount?.total ?? 0) + (refusedCount?.total ?? 0) };
  }

  async findByIds(ids: readonly string[]): Promise<MessageRow[]> {
    if (ids.length === 0) return [];
    return this.database.db
      .select()
      .from(messages)
      .where(inArray(messages.id, [...ids] as MessageId[]));
  }

  async list(filter: MessageFilter): Promise<{ rows: MessageRow[]; total: number }> {
    const where = and(
      filter.clientId === undefined ? undefined : eq(messages.clientId, filter.clientId),
      filter.partnerId === undefined ? undefined : eq(messages.partnerId, filter.partnerId),
      filter.status === undefined ? undefined : eq(messages.status, filter.status),
      filter.from === undefined ? undefined : gte(messages.createdAt, filter.from),
      filter.to === undefined ? undefined : lt(messages.createdAt, filter.to),
    );
    const rows = await this.database.db
      .select()
      .from(messages)
      .where(where)
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(filter.limit)
      .offset(filter.offset);
    const [counted] = await this.database.db.select({ total: count() }).from(messages).where(where);
    return { rows, total: counted?.total ?? 0 };
  }

  /**
   * Кандидаты под сообщение ([ADR-0079](../../../../../docs/adr/0079-raspredelenie-soobscheniy-i-zdorove-akkauntov.md)):
   * рабочие аккаунты с ценой, не на паузе, самой дешёвой цены, а в ней — давно не работавшие первыми. Читается
   * `limit` строк, а не все: у партнёра их могут быть сотни. `partnerId` и `price` сужают выбор до «соседей»
   * по сообщению, `exceptPartners` — до допущенных партнёров, `exceptId` — без самого аккаунта.
   */
  async listCandidates(filter: {
    now: Date;
    limit: number;
    partnerId?: Id<'partner'>;
    price?: MoneyAmount;
    exceptId?: Id<'messengerAccount'>;
    exceptPartners: readonly Id<'partner'>[];
    /** Только эти партнёры — одна цифра списка клиента (ADR-0081). */
    onlyPartners?: readonly Id<'partner'>[];
    offset?: number;
    /** Требования клиента и его ручные отключения (ADR-0092). */
    rules?: ClientRules;
  }): Promise<MessengerAccountRow[]> {
    const rules = filter.rules;
    if (rules?.impossible === true) return [];
    const conditions = [
      eq(messengerAccounts.status, 'active'),
      isNotNull(messengerAccounts.price),
      or(isNull(messengerAccounts.pausedUntil), lt(messengerAccounts.pausedUntil, filter.now)),
      filter.partnerId === undefined
        ? undefined
        : eq(messengerAccounts.partnerId, filter.partnerId),
      filter.price === undefined ? undefined : eq(messengerAccounts.price, filter.price),
      filter.exceptId === undefined ? undefined : ne(messengerAccounts.id, filter.exceptId),
      filter.exceptPartners.length === 0
        ? undefined
        : notInArray(messengerAccounts.partnerId, [...filter.exceptPartners]),
      filter.onlyPartners === undefined
        ? undefined
        : inArray(messengerAccounts.partnerId, [...filter.onlyPartners]),
      rules?.stopLine === undefined ? undefined : eq(messengerAccounts.stopLine, rules.stopLine),
      rules?.recommendedOnly === true ? eq(messengerAccounts.recommended, true) : undefined,
      rules?.maxPartnerPrice === undefined
        ? undefined
        : lte(messengerAccounts.price, rules.maxPartnerPrice),
      rules?.createdBefore === undefined
        ? undefined
        : lte(messengerAccounts.createdAt, rules.createdBefore),
      rules === undefined || rules.exceptAccounts.length === 0
        ? undefined
        : notInArray(messengerAccounts.id, [...rules.exceptAccounts]),
    ];
    // Самая дешёвая цена среди подходящих: только её группа — цена клиента не прыгает на дорогой аккаунт.
    const [cheapest] = await this.database.db
      .select({ price: min(messengerAccounts.price) })
      .from(messengerAccounts)
      .where(and(...conditions));
    if (cheapest?.price === null || cheapest?.price === undefined) return [];
    // Порядок задаёт партнёр (ADR-0080): «по порядку» и «по приоритету» — по номеру в списке, остальные режимы —
    // давно не работавшие первыми. Без настройки — давно не работавшие.
    const ranked = sql`case when ${partnerDistributions.mode} in ('sequential', 'priority') then ${messengerAccounts.distributionPriority} else 0 end`;
    const recency = sql`case when ${partnerDistributions.mode} = 'sequential' then null else ${messengerAccounts.lastUsedAt} end`;
    return this.database.db
      .select(getTableColumns(messengerAccounts))
      .from(messengerAccounts)
      .leftJoin(
        partnerDistributions,
        and(
          eq(partnerDistributions.partnerId, messengerAccounts.partnerId),
          eq(partnerDistributions.product, 'message'),
        ),
      )
      .where(and(...conditions, eq(messengerAccounts.price, cheapest.price)))
      .orderBy(asc(ranked), sql`${recency} asc nulls first`, asc(messengerAccounts.id))
      .limit(filter.limit)
      .offset(filter.offset ?? 0);
  }

  /**
   * Цена партнёров за сообщение: от и до по их рабочим аккаунтам с ценой (ADR-0081). Нужна клиенту, чтобы расставить
   * приоритеты, видя цену; цену клиента строит сервис — с наценкой.
   */
  async partnerPriceRanges(
    now: Date,
  ): Promise<{ partnerId: Id<'partner'>; min: MoneyAmount; max: MoneyAmount }[]> {
    const rows = await this.database.db
      .select({
        partnerId: messengerAccounts.partnerId,
        min: min(messengerAccounts.price),
        max: max(messengerAccounts.price),
      })
      .from(messengerAccounts)
      .where(
        and(
          eq(messengerAccounts.status, 'active'),
          isNotNull(messengerAccounts.price),
          or(isNull(messengerAccounts.pausedUntil), lt(messengerAccounts.pausedUntil, now)),
        ),
      )
      .groupBy(messengerAccounts.partnerId);
    return rows.flatMap((row) =>
      row.min === null || row.max === null
        ? []
        : [{ partnerId: row.partnerId, min: row.min, max: row.max }],
    );
  }

  /**
   * Когда в скользящем окне аккаунта освободится место: из последних `allowed` отправок самая ранняя выходит из окна. Пусто —
   * в окне меньше `allowed` отправок (место уже есть).
   */
  async windowFreesAt(
    accountId: Id<'messengerAccount'>,
    window: { windowMs: number; allowed: number },
    now: Date,
  ): Promise<Date | undefined> {
    const [row] = await this.database.db
      .select({ sentAt: messages.sentAt })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, accountId),
          gte(messages.sentAt, new Date(now.getTime() - window.windowMs)),
        ),
      )
      .orderBy(desc(messages.sentAt))
      .offset(window.allowed - 1)
      .limit(1);
    return row?.sentAt == null ? undefined : new Date(row.sentAt.getTime() + window.windowMs);
  }

  /** Отправки аккаунтов за минуту, час и сутки и очередь за ними — для лимитов. Одним запросом на всех кандидатов. */
  async loadOf(
    accountIds: readonly Id<'messengerAccount'>[],
    now: Date,
  ): Promise<Map<string, AccountLoad>> {
    const result = new Map<string, AccountLoad>();
    if (accountIds.length === 0) return result;
    const minuteAgo = new Date(now.getTime() - 60_000);
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const ids = [...accountIds];
    const sent = await this.database.db
      .select({
        accountId: messages.accountId,
        minute: sql<number>`count(*) filter (where ${messages.sentAt} >= ${minuteAgo})::int`,
        hour: sql<number>`count(*) filter (where ${messages.sentAt} >= ${hourAgo})::int`,
        day: sql<number>`count(*)::int`,
      })
      .from(messages)
      .where(and(inArray(messages.accountId, ids), gte(messages.sentAt, dayAgo)))
      .groupBy(messages.accountId);
    const queued = await this.database.db
      .select({ accountId: messages.accountId, backlog: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(inArray(messages.accountId, ids), inArray(messages.status, ['queued', 'sending'])))
      .groupBy(messages.accountId);
    for (const id of ids) result.set(id, { minute: 0, hour: 0, day: 0, backlog: 0 });
    for (const row of sent) {
      if (row.accountId === null) continue;
      const load = result.get(row.accountId);
      if (load !== undefined)
        Object.assign(load, { minute: row.minute, hour: row.hour, day: row.day });
    }
    for (const row of queued) {
      if (row.accountId === null) continue;
      const load = result.get(row.accountId);
      if (load !== undefined) Object.assign(load, { backlog: row.backlog });
    }
    return result;
  }

  /** С какого аккаунта клиент последний раз писал этому номеру (после `since`); `undefined` — не писал. */
  async lastAccountFor(
    clientId: Id<'client'>,
    recipient: string,
    since: Date,
  ): Promise<Id<'messengerAccount'> | undefined> {
    const [row] = await this.database.db
      .select({ accountId: messages.accountId })
      .from(messages)
      .where(
        and(
          eq(messages.clientId, clientId),
          eq(messages.recipient, recipient),
          eq(messages.route, 'account'),
          isNotNull(messages.accountId),
          gte(messages.createdAt, since),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return row?.accountId ?? undefined;
  }

  /** Сообщение переносится на другой аккаунт того же партнёра и той же цены, пока оно «в работе». */
  async reassign(id: MessageId, accountId: Id<'messengerAccount'>): Promise<void> {
    await this.database.db
      .update(messages)
      .set({ accountId })
      .where(and(eq(messages.id, id), eq(messages.status, 'sending')));
  }

  async findAccount(id: Id<'messengerAccount'>): Promise<MessengerAccountRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(messengerAccounts)
      .where(eq(messengerAccounts.id, id));
    return row;
  }

  async findAccountByInstance(
    provider: MessengerAccountRow['provider'],
    instanceId: string,
  ): Promise<MessengerAccountRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(messengerAccounts)
      .where(
        and(
          eq(messengerAccounts.provider, provider),
          eq(messengerAccounts.providerInstanceId, instanceId),
        ),
      );
    return row;
  }

  /**
   * Берёт сообщения, которым пора уходить, и помечает их `sending` — одной транзакцией с блокировкой
   * строк (`skip locked`): два воркера не возьмут одно и то же. Взятое и брошенное (воркер умер)
   * через `LEASE_MS` берётся заново. Счётчик попыток растёт при взятии.
   */
  async claimDue(now: Date, limit: number): Promise<MessageRow[]> {
    return this.database.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            lt(messages.nextAttemptAt, new Date(now.getTime() + 1)),
            or(
              eq(messages.status, 'queued'),
              and(
                eq(messages.status, 'sending'),
                lt(messages.nextAttemptAt, new Date(now.getTime() - LEASE_MS)),
              ),
            ),
          ),
        )
        .orderBy(asc(messages.nextAttemptAt), asc(messages.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      return tx
        .update(messages)
        .set({ status: 'sending', attempts: sql`${messages.attempts} + 1`, nextAttemptAt: now })
        .where(
          inArray(
            messages.id,
            due.map((row) => row.id),
          ),
        )
        .returning();
    });
  }

  /** Вернуть в очередь не раньше `at` (пауза, лимит, временный сбой). Попытка, если не засчитана, откатывается. */
  /**
   * Когда очередь аккаунта дойдёт до этого сообщения: позднейшая следующая попытка у сообщений того же аккаунта, принятых
   * **раньше** и ещё не ушедших. Нет таких — `undefined`, сообщение первое в очереди. Без этого новое уходило раньше
   * ждущего: у ждущего попытка сдвинута на «аккаунт освободится», у нового — «сейчас», и ждущее истекало (владелец,
   * 2026-10-23: 08:56:49 истекло, 08:56:55 ушло).
   */
  async queuedAheadUntil(
    accountId: MessengerAccountRow['id'],
    message: Pick<MessageRow, 'id' | 'createdAt'>,
  ): Promise<Date | undefined> {
    const [row] = await this.database.db
      .select({ until: max(messages.nextAttemptAt) })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, accountId),
          inArray(messages.status, ['queued', 'sending']),
          ne(messages.id, message.id),
          or(
            lt(messages.createdAt, message.createdAt),
            and(eq(messages.createdAt, message.createdAt), lt(messages.id, message.id)),
          ),
        ),
      );
    return row?.until ?? undefined;
  }

  /**
   * Есть ли у аккаунта сообщения, **отложенные** до его освобождения (попытка позже `now`): тогда новое за ними, а не
   * «отправить сразу». Принятые, но ещё не взятые воркером (попытка уже наступила) аккаунт занятым не делают — это обычная
   * задержка до ближайшего прохода, порядок между ними держит `claimDue`.
   */
  async hasDeferred(accountId: MessengerAccountRow['id'], now: Date): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, accountId),
          eq(messages.status, 'queued'),
          gt(messages.nextAttemptAt, now),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async requeue(id: MessageId, at: Date, refundAttempt: boolean): Promise<void> {
    await this.database.db
      .update(messages)
      .set({
        status: 'queued',
        nextAttemptAt: at,
        ...(refundAttempt ? { attempts: sql`greatest(${messages.attempts} - 1, 0)` } : {}),
      })
      .where(and(eq(messages.id, id), eq(messages.status, 'sending')));
  }

  /** Ушло в мессенджер. Условие на `sending`: повторный разбор не затирает продвинувшийся статус. */
  async markSent(
    id: MessageId,
    providerMessageId: string,
    at: Date,
    sentText: string,
    stopLine = false,
  ): Promise<void> {
    await this.database.db
      .update(messages)
      .set({ status: 'sent', providerMessageId, sentAt: at, stopLine, sentText })
      .where(and(eq(messages.id, id), eq(messages.status, 'sending')));
  }

  /** Сообщение бота: MAX принял его — это и есть доставка (отчёта о прочтении у бота нет). */
  async markDelivered(id: MessageId, at: Date): Promise<void> {
    await this.database.db
      .update(messages)
      .set({ status: 'delivered', deliveredAt: at })
      .where(and(eq(messages.id, id), eq(messages.status, 'sent')));
  }

  /** Окончательный отказ без денег (бесплатное сообщение бота): отдельной транзакции возврата нет. */
  async markFailedFree(id: MessageId, reason: MessageFailureReason, at: Date): Promise<void> {
    await this.markFailed(id, reason, at, this.database.db);
  }

  /** Аккаунт только что отправлял: от этого момента считается пауза и порядок выбора. */
  async touchAccount(id: Id<'messengerAccount'>, at: Date): Promise<void> {
    // Молчал дольше срока — прогрев начинается заново (ADR-0078, ревизия 2026-10-18). В одном запросе: выражения
    // `set` видят прежние значения строки, так что «молчал» проверяется по старой `last_used_at`.
    const idle = sql`${messengerAccounts.warmupEnabled}
      and ${messengerAccounts.warmupStartedAt} is not null
      and greatest(coalesce(${messengerAccounts.lastUsedAt}, ${messengerAccounts.warmupStartedAt}), ${messengerAccounts.warmupStartedAt})
        < ${at}::timestamptz - ${WARMUP_IDLE_DAYS} * interval '1 day'`;
    await this.database.db
      .update(messengerAccounts)
      .set({
        lastUsedAt: at,
        // Начало — сутки назад: перезапущенный продолжает с суток 1, а не молчит ещё сутки (ADR-0078, ревизия 2026-10-23).
        warmupStartedAt: sql`case when ${idle} then ${at}::timestamptz - interval '1 day' else ${messengerAccounts.warmupStartedAt} end`,
      })
      .where(eq(messengerAccounts.id, id));
  }

  /**
   * Партнёры, у которых с `since` два и больше аккаунта стали «Ограничен» или «Заблокирован» (ADR-0078, ревизия 2026-10-23): пачка
   * ограничений — признак, что аккаунты связаны или прогрев слишком резкий, и администратор должен узнать сразу.
   */
  async restrictedBursts(
    since: Date,
  ): Promise<{ partnerId: string; partnerName: string; accounts: number }[]> {
    const result = await this.database.db.execute(sql`
      select a.partner_id as "partnerId", p.name as "partnerName", count(distinct e.account_id)::int as accounts
        from messenger_account_events e
        join messenger_accounts a on a.id = e.account_id
        join partners p on p.id = a.partner_id
       where e.kind = 'unavailable' and e.reason in ('suspended', 'blocked') and e.created_at >= ${since}
       group by a.partner_id, p.name
      having count(distinct e.account_id) >= 2`);
    return result.rows as { partnerId: string; partnerName: string; accounts: number }[];
  }

  /** Сколько сообщений этому номеру от этого клиента принято не раньше `since` (неотклонённых). */
  async countToRecipient(clientId: Id<'client'>, recipient: string, since: Date): Promise<number> {
    const [row] = await this.database.db
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.clientId, clientId),
          eq(messages.recipient, recipient),
          gte(messages.createdAt, since),
          ne(messages.status, 'failed'),
        ),
      );
    return row?.n ?? 0;
  }

  /**
   * Серия непрочитанных у номера (ADR-0088, ревизия 2026-10-23): доставленные через аккаунты партнёров, принятые до `maturedBefore`,
   * после последнего прочитанного им сообщения. Через всех клиентов: молчит человек, а не клиент.
   */
  async unreadStreak(recipient: string, maturedBefore: Date): Promise<number> {
    const [row] = await this.database.db
      .select({ n: count() })
      .from(messages)
      .where(this.unreadWhere(recipient, maturedBefore));
    return row?.n ?? 0;
  }

  /** Когда принято `position`-е по счёту (с 1, от старых) непрочитанное серии; нет такого — `undefined`. */
  async unreadAt(
    recipient: string,
    maturedBefore: Date,
    position: number,
  ): Promise<Date | undefined> {
    const [row] = await this.database.db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(this.unreadWhere(recipient, maturedBefore))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .offset(position - 1)
      .limit(1);
    return row?.createdAt;
  }

  private unreadWhere(recipient: string, maturedBefore: Date) {
    const lastRead = this.database.db
      .select({ at: max(messages.createdAt) })
      .from(messages)
      .where(
        and(
          eq(messages.recipient, recipient),
          eq(messages.route, 'account'),
          eq(messages.status, 'read'),
        ),
      );
    return and(
      eq(messages.recipient, recipient),
      eq(messages.route, 'account'),
      eq(messages.status, 'delivered'),
      lt(messages.createdAt, maturedBefore),
      sql`${messages.createdAt} > coalesce((${lastRead}), '-infinity'::timestamptz)`,
    );
  }

  /** Было ли такое же сообщение этому номеру от этого клиента не раньше `since` (неотклонённое). */
  async hasRecentDuplicate(
    clientId: Id<'client'>,
    recipient: string,
    text: string,
    since: Date,
  ): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.clientId, clientId),
          eq(messages.recipient, recipient),
          eq(messages.text, text),
          gte(messages.createdAt, since),
          ne(messages.status, 'failed'),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Окончательный отказ — внутри транзакции возврата денег. Только из ещё не отправленных состояний. */
  async markFailed(
    id: MessageId,
    reason: MessageFailureReason,
    at: Date,
    executor: Executor,
  ): Promise<void> {
    await executor
      .update(messages)
      .set({ status: 'failed', failureReason: reason, failedAt: at })
      .where(and(eq(messages.id, id), inArray(messages.status, ['queued', 'sending', 'sent'])));
  }

  /**
   * Итоги по аккаунтам за окно: сколько сообщений ушло и у скольких MAX уже после отправки сообщил «нет аккаунта»
   * (`sent_at` заполнен — отказ предпроверки до отправки аккаунту не вредит и не считается). Аккаунты на паузе и
   * списанные не считаются; счёт идёт с `health_since` аккаунта.
   */
  async healthOutcomes(
    since: Date,
    now: Date,
  ): Promise<{ accountId: Id<'messengerAccount'>; absent: number; ok: number }[]> {
    const result = await this.database.db.execute(sql`
      select m.account_id as "accountId",
             count(*) filter (where m.status = 'failed' and m.failure_reason = 'recipient_not_in_max')::int as absent,
             count(*) filter (where m.status in ('sent', 'delivered', 'read'))::int as ok
        from messages m
        join messenger_accounts a on a.id = m.account_id
       where m.sent_at >= ${since}
         and (a.health_since is null or m.sent_at >= a.health_since)
         and a.status <> 'retired'
         and (a.paused_until is null or a.paused_until <= ${now})
       group by m.account_id
    `);
    return result.rows as { accountId: Id<'messengerAccount'>; absent: number; ok: number }[];
  }

  /** Сколько аккаунтов сейчас работают: вошли и не на паузе. */
  async countWorking(now: Date): Promise<number> {
    const [row] = await this.database.db
      .select({ total: count() })
      .from(messengerAccounts)
      .where(
        and(
          eq(messengerAccounts.status, 'active'),
          or(isNull(messengerAccounts.pausedUntil), lt(messengerAccounts.pausedUntil, now)),
        ),
      );
    return row?.total ?? 0;
  }

  /** Ждут отправки дольше срока. */
  /**
   * Ждущие сверх срока: свой срок у сообщения (ADR-0097) прошёл, а у строк без срока — принятые раньше `before` (прежнее правило
   * площадки). Догоняюще, по сроку, а не «с прошлого запуска».
   */
  listWaitingBefore(before: Date, limit: number, now: Date = new Date()): Promise<MessageRow[]> {
    return this.database.db
      .select()
      .from(messages)
      .where(
        and(
          inArray(messages.status, ['queued', 'sending']),
          or(
            and(isNotNull(messages.expiresAt), lt(messages.expiresAt, now)),
            and(isNull(messages.expiresAt), lt(messages.createdAt, before)),
          ),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(limit);
  }

  /**
   * Статус доставки от провайдера: только вперёд (`sent` → `delivered` → `read`), по идентификатору
   * сообщения у провайдера и аккаунту. Возвращает строку, если что-то изменилось.
   */
  async advance(
    accountId: Id<'messengerAccount'>,
    providerMessageId: string,
    to: 'delivered' | 'read',
    at: Date,
  ): Promise<MessageRow | undefined> {
    const from: MessageStatus[] = to === 'delivered' ? ['sent'] : ['sent', 'delivered'];
    const [row] = await this.database.db
      .update(messages)
      .set(
        to === 'delivered'
          ? { status: 'delivered', deliveredAt: at }
          : {
              status: 'read',
              readAt: at,
              deliveredAt: sql`coalesce(${messages.deliveredAt}, ${at})`,
            },
      )
      .where(
        and(
          eq(messages.accountId, accountId),
          eq(messages.providerMessageId, providerMessageId),
          inArray(messages.status, from),
        ),
      )
      .returning();
    return row;
  }

  async findByProviderId(
    accountId: Id<'messengerAccount'>,
    providerMessageId: string,
  ): Promise<MessageRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(messages)
      .where(
        and(eq(messages.accountId, accountId), eq(messages.providerMessageId, providerMessageId)),
      );
    return row;
  }

  /**
   * Сообщения SMPP, по которым есть неотданный отчёт ([ADR-0076](../../../../docs/adr/0076-statusy-smpp-po-nastrojkam-klienta.md)):
   * отказ, либо событие (ушло, доставлено, прочитано), на которое у клиента включён отчёт, а в сообщении оно ещё
   * не отмечено обработанным. Не старше `since`. Опрашивается, пока у клиента есть вошедший приёмник.
   */
  async pendingReceipts(
    clientIds: readonly Id<'client'>[],
    since: Date,
    limit: number,
  ): Promise<{ message: MessageRow; map: SmppReceiptMap }[]> {
    if (clientIds.length === 0) return [];
    const open = (event: SmppReceiptEvent) => sql`not ${event} = any(${messages.receiptEvents})`;
    const rows = await this.database.db
      .select({
        message: messages,
        onSent: smppAccounts.receiptOnSent,
        onDelivered: smppAccounts.receiptOnDelivered,
        onRead: smppAccounts.receiptOnRead,
      })
      .from(messages)
      .innerJoin(smppAccounts, eq(smppAccounts.clientId, messages.clientId))
      .where(
        and(
          eq(messages.channel, 'smpp'),
          inArray(messages.clientId, [...clientIds]),
          gte(messages.createdAt, since),
          or(
            and(eq(messages.status, 'failed'), sql`not 'failed' = any(${messages.receiptEvents})`),
            and(
              inArray(messages.status, ['sent', 'delivered', 'read']),
              sql`${smppAccounts.receiptOnSent} <> 'none'`,
              open('sent'),
            ),
            and(
              inArray(messages.status, ['delivered', 'read']),
              sql`${smppAccounts.receiptOnDelivered} <> 'none'`,
              open('delivered'),
            ),
            and(
              eq(messages.status, 'read'),
              sql`${smppAccounts.receiptOnRead} <> 'none'`,
              open('read'),
            ),
          ),
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(limit);
    return rows.map((row) => ({
      message: row.message,
      map: { sent: row.onSent, delivered: row.onDelivered, read: row.onRead },
    }));
  }

  /** Событие обработано (отчёт принят клиентом или не нужен): повторно не отдаём. `sentAt` — время приёма отчёта. */
  async markReceiptEvent(
    id: MessageId,
    event: SmppReceiptEvent | 'failed',
    sentAt: Date | null,
  ): Promise<void> {
    await this.database.db
      .update(messages)
      .set({
        receiptEvents: sql`array_append(${messages.receiptEvents}, ${event})`,
        ...(sentAt === null ? {} : { receiptSentAt: sentAt }),
      })
      .where(and(eq(messages.id, id), sql`not ${event} = any(${messages.receiptEvents})`));
  }

  /**
   * Сообщения по суткам с `since`: сколько принято, доставлено, не отправлено и деньги (без возвращённых).
   * Сутки считаются по часам человека (`offsetMinutes` — к востоку от UTC), как в сводке звонков.
   */
  async dailyCounts(
    since: Date,
    offsetMinutes: number,
  ): Promise<
    {
      day: string;
      messages: number;
      delivered: number;
      failed: number;
      revenue: bigint;
      margin: bigint;
    }[]
  > {
    const result = await this.database.db.execute(sql`
      select to_char(created_at + make_interval(mins => ${offsetMinutes}), 'YYYY-MM-DD') as day,
             count(*)::int as messages,
             (count(*) filter (where status in ('delivered', 'read')))::int as delivered,
             (count(*) filter (where status = 'failed'))::int as failed,
             coalesce(sum(client_amount) filter (where status <> 'failed'), 0)::text as revenue,
             coalesce(sum(commission_amount) filter (where status <> 'failed'), 0)::text as margin
        from messages
       where created_at >= ${since}
       group by 1
       order by 1`);
    return (
      result.rows as {
        day: string;
        messages: number;
        delivered: number;
        failed: number;
        revenue: string;
        margin: string;
      }[]
    ).map((row) => ({ ...row, revenue: BigInt(row.revenue), margin: BigInt(row.margin) }));
  }

  /** Настоящая проверка «есть ли у номера MAX» у провайдера (ADR-0088); номер не записывается. */
  async addNumberCheck(
    accountId: Id<'messengerAccount'>,
    result: NumberCheckResult,
  ): Promise<void> {
    await this.database.db
      .insert(numberChecks)
      .values({ id: newId<'numberCheck'>(), accountId, result });
  }

  /** Старые записи журналов (проверки номеров и история аккаунтов): `checksBefore` и `eventsBefore` — граница хранения. */
  async purgeJournals(checksBefore: Date, eventsBefore: Date): Promise<void> {
    await this.database.db.delete(numberChecks).where(lt(numberChecks.createdAt, checksBefore));
    await this.database.db
      .delete(messengerAccountEvents)
      .where(lt(messengerAccountEvents.createdAt, eventsBefore));
  }

  /**
   * Чьё сообщение этот номер получил с аккаунта последним (не раньше `since`): по нему «СТОП» относится к клиенту, а не ко
   * всем (ADR-0088). Аккаунт — по идентификатору инстанса у провайдера.
   */
  async lastClientSentTo(
    instanceId: string,
    recipient: string,
    since: Date,
  ): Promise<Id<'client'> | undefined> {
    const result = await this.database.db.execute(sql`
      select m.client_id as "clientId"
        from messages m
        join messenger_accounts a on a.id = m.account_id
       where a.provider_instance_id = ${instanceId}
         and m.recipient = ${recipient}
         and m.route = 'account'
         and m.status in ('sent', 'delivered', 'read')
         and m.sent_at >= ${since}
       order by m.sent_at desc
       limit 1`);
    return (result.rows[0] as { clientId: Id<'client'> } | undefined)?.clientId;
  }

  /**
   * Журнал аккаунтов за окно: по каждому аккаунту, у которого что-то было, — проверки номеров по итогам и события состояния, и
   * последние события лентой. Аккаунт без единой записи в строки не попадает.
   */
  async journal(
    since: Date,
    recentLimit: number,
  ): Promise<{ accounts: AccountJournalRow[]; recent: AccountEventRow[] }> {
    const accounts = await this.database.db.execute(sql`
      select a.id as "accountId", a.label as label, p.name as "partnerName", a.status as status,
             coalesce(c.exists, 0)::int as checks_exists, coalesce(c.absent, 0)::int as checks_absent,
             coalesce(c.unknown, 0)::int as checks_unknown, coalesce(c.limited, 0)::int as checks_limited,
             coalesce(e.blocked, 0)::int as blocked, coalesce(e.suspended, 0)::int as suspended,
             coalesce(e.logged_out, 0)::int as logged_out, coalesce(e.health_paused, 0)::int as health_paused
        from messenger_accounts a
        join partners p on p.id = a.partner_id
        left join (
          select account_id,
                 count(*) filter (where result = 'exists') as exists,
                 count(*) filter (where result = 'absent') as absent,
                 count(*) filter (where result = 'unknown') as unknown,
                 count(*) filter (where result = 'limited') as limited
            from number_checks where created_at >= ${since} group by account_id
        ) c on c.account_id = a.id
        left join (
          select account_id,
                 count(*) filter (where kind = 'unavailable' and reason = 'blocked') as blocked,
                 count(*) filter (where kind = 'unavailable' and reason = 'suspended') as suspended,
                 count(*) filter (where kind = 'unavailable' and reason = 'logged_out') as logged_out,
                 count(*) filter (where kind = 'health_paused') as health_paused
            from messenger_account_events where created_at >= ${since} group by account_id
        ) e on e.account_id = a.id
       where c.account_id is not null or e.account_id is not null`);
    const recent = await this.database.db.execute(sql`
      select e.account_id as "accountId", a.label as label, e.kind as kind, e.reason as reason, e.created_at as "createdAt"
        from messenger_account_events e
        join messenger_accounts a on a.id = e.account_id
       where e.created_at >= ${since}
       order by e.created_at desc
       limit ${recentLimit}`);
    return {
      accounts: accounts.rows as unknown as AccountJournalRow[],
      recent: (
        recent.rows as unknown as (Omit<AccountEventRow, 'createdAt'> & {
          createdAt: string | Date;
        })[]
      ).map((row) => ({ ...row, createdAt: new Date(row.createdAt) })),
    };
  }

  /**
   * Отчёт для сотрудников за окно: по клиентам и по аккаунтам. «Не прочитано» считается только у ушедших через аккаунты и
   * старше суток (`settledBefore`): у бота статуса «прочитано» нет, а свежее сообщение ещё не успели прочитать.
   */
  async report(
    since: Date,
    settledBefore: Date,
  ): Promise<{ clients: ClientReportRow[]; accounts: AccountReportRow[] }> {
    const counts = sql`
             count(*)::int as total,
             (count(*) filter (where m.status in ('sent', 'delivered', 'read')))::int as sent,
             (count(*) filter (where m.status in ('delivered', 'read')))::int as delivered,
             (count(*) filter (where m.status = 'read'))::int as read,
             (count(*) filter (where m.status = 'failed'))::int as failed,
             (count(*) filter (where m.failure_reason = 'recipient_not_in_max'))::int as not_in_max,
             (count(*) filter (where m.failure_reason = 'account_unavailable'))::int as account_unavailable,
             (count(*) filter (where m.failure_reason = 'wait_expired'))::int as wait_expired,
             (count(*) filter (where m.failure_reason = 'provider_timeout'))::int as provider_timeout,
             (count(*) filter (where m.failure_reason = 'platform'))::int as platform,
             (count(*) filter (where m.failure_reason = 'recipient_stopped'))::int as recipient_stopped,
             (count(*) filter (where m.route = 'account' and m.sent_at < ${settledBefore}
                                 and m.status in ('sent', 'delivered', 'read')))::int as settled,
             (count(*) filter (where m.route = 'account' and m.sent_at < ${settledBefore}
                                 and m.status = 'read'))::int as settled_read`;
    const byClient = await this.database.db.execute(sql`
      select m.client_id as "clientId", c.name as name, ${counts}
        from messages m
        join clients c on c.id = m.client_id
       where m.created_at >= ${since}
       group by m.client_id, c.name
       order by count(*) desc`);
    const byAccount = await this.database.db.execute(sql`
      select m.account_id as "accountId", a.label as label, p.name as "partnerName",
             a.status as status, a.state_reason as "stateReason", a.paused_until as "pausedUntil",
             a.pause_reason as "pauseReason", ${counts}
        from messages m
        join messenger_accounts a on a.id = m.account_id
        join partners p on p.id = a.partner_id
       where m.created_at >= ${since}
       group by m.account_id, a.label, p.name, a.status, a.state_reason, a.paused_until, a.pause_reason
       order by count(*) desc`);
    return {
      clients: byClient.rows as unknown as ClientReportRow[],
      accounts: byAccount.rows as unknown as AccountReportRow[],
    };
  }

  /**
   * Бот или аккаунты (ADR-0094): сколько получателей писали клиенту с `since`, сколько из них сейчас подписаны на его бота
   * (поделились номером и не остановили), сколько ушедших сообщений прошло ботом и сколько через аккаунты партнёров.
   * Без клиента — по каждому клиенту, у которого были сообщения.
   */
  async routeStats(since: Date, clientId?: Id<'client'>): Promise<RouteStatsRow[]> {
    const result = await this.database.db.execute(sql`
      with sent as (
        select m.client_id, m.recipient, m.route
          from messages m
         where m.created_at >= ${since}
           and m.status in ('sent', 'delivered', 'read')
           ${clientId === undefined ? sql`` : sql`and m.client_id = ${clientId}`}
      ),
      people as (
        select distinct client_id, recipient from sent
      )
      select c.id as "clientId", c.name as name,
             (select count(*)::int from people p where p.client_id = c.id) as recipients,
             (select count(*)::int from people p
               where p.client_id = c.id
                 and exists (select 1 from bot_subscribers b
                              where b.client_id = p.client_id and b.phone = p.recipient and b.state = 'started')
             ) as "inBot",
             (select count(*)::int from sent s where s.client_id = c.id and s.route = 'bot') as "viaBot",
             (select count(*)::int from sent s where s.client_id = c.id and s.route = 'account') as "viaAccounts"
        from clients c
       where c.id in (select client_id from people)
       order by recipients desc, c.name`);
    return result.rows as unknown as RouteStatsRow[];
  }

  /** Принято и окончательно не отправлено с `since`: по этому судят, что отправка в целом сломалась. */
  async healthSince(since: Date): Promise<{ total: number; failed: number }> {
    const [row] = await this.database.db
      .select({
        total: count(),
        failed: sql<number>`(count(*) filter (where ${messages.status} = 'failed'))::int`,
      })
      .from(messages)
      .where(gte(messages.createdAt, since));
    return { total: row?.total ?? 0, failed: row?.failed ?? 0 };
  }

  /** Стирает текст сообщений старше срока; строка с суммами остаётся. Возвращает, сколько стёрто. */
  async purgeTexts(before: Date): Promise<number> {
    const erased = await this.database.db
      .update(messages)
      .set({ text: '', sentText: null })
      .where(
        and(
          lt(messages.createdAt, before),
          or(ne(messages.text, ''), isNotNull(messages.sentText)),
        ),
      )
      .returning({ id: messages.id });
    return erased.length;
  }
}
