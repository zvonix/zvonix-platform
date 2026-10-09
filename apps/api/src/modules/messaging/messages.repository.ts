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
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  min,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { toDatabaseError, type Executor } from '@zvonix/db';
import { messages, messengerAccounts, partnerDistributions, smppAccounts } from '@zvonix/db/schema';
import {
  newId,
  type Id,
  type MessageChannel,
  type MessageFailureReason,
  type MessageRoute,
  type MessageStatus,
  type MoneyAmount,
  type SmppReceiptEvent,
  type SmppReceiptMap,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';
import type { MessengerAccountRow } from './messaging.repository.js';

export type MessageRow = typeof messages.$inferSelect;
export type MessageId = Id<'message'>;

/** Нагрузка на аккаунт: отправки за минуту, час, сутки и очередь, которая за ним стоит. */
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
  readonly status?: MessageStatus;
  readonly limit: number;
  readonly offset: number;
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

  async list(filter: MessageFilter): Promise<{ rows: MessageRow[]; total: number }> {
    const where = and(
      filter.clientId === undefined ? undefined : eq(messages.clientId, filter.clientId),
      filter.status === undefined ? undefined : eq(messages.status, filter.status),
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
    offset?: number;
  }): Promise<MessengerAccountRow[]> {
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
  async markSent(id: MessageId, providerMessageId: string, at: Date): Promise<void> {
    await this.database.db
      .update(messages)
      .set({ status: 'sent', providerMessageId, sentAt: at })
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
    await this.database.db
      .update(messengerAccounts)
      .set({ lastUsedAt: at })
      .where(eq(messengerAccounts.id, id));
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
  listWaitingBefore(before: Date, limit: number): Promise<MessageRow[]> {
    return this.database.db
      .select()
      .from(messages)
      .where(and(inArray(messages.status, ['queued', 'sending']), lt(messages.createdAt, before)))
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
      .set({ text: '' })
      .where(and(lt(messages.createdAt, before), ne(messages.text, '')))
      .returning({ id: messages.id });
    return erased.length;
  }
}
