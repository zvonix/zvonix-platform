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
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { toDatabaseError, type Executor } from '@zvonix/db';
import { messages, messengerAccounts } from '@zvonix/db/schema';
import {
  newId,
  type Id,
  type MessageChannel,
  type MessageFailureReason,
  type MessageStatus,
  type MoneyAmount,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';
import type { MessengerAccountRow } from './messaging.repository.js';

export type MessageRow = typeof messages.$inferSelect;
export type MessageId = Id<'message'>;

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
      accountId: Id<'messengerAccount'>;
      partnerId: Id<'partner'>;
      clientAmount: MoneyAmount;
      partnerAmount: MoneyAmount;
      commissionAmount: MoneyAmount;
    },
    executor: Executor,
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
   * Аккаунты, на которые можно принять сообщение: вошли, цена назначена. Дешёвый первым, при равной
   * цене — тот, что дольше не отправлял. Допущен ли партнёр к работе, проверяет служба.
   */
  listEligibleAccounts(): Promise<MessengerAccountRow[]> {
    return this.database.db
      .select()
      .from(messengerAccounts)
      .where(and(eq(messengerAccounts.status, 'active'), isNotNull(messengerAccounts.price)))
      .orderBy(
        asc(messengerAccounts.price),
        asc(messengerAccounts.lastUsedAt),
        asc(messengerAccounts.id),
      );
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

  /** Сколько отправил аккаунт с `since` — для лимитов в минуту и в сутки. */
  async countSentSince(accountId: Id<'messengerAccount'>, since: Date): Promise<number> {
    const [row] = await this.database.db
      .select({ total: count() })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), gte(messages.sentAt, since)));
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
   * Сообщения SMPP, чей отчёт о доставке ещё не отдан: дошли до конца (доставлено, прочитано, отказ),
   * не старше `since`. Опрашивается, пока у клиента есть вошедший приёмник (ADR-0072).
   */
  pendingReceipts(
    clientIds: readonly Id<'client'>[],
    since: Date,
    limit: number,
  ): Promise<MessageRow[]> {
    if (clientIds.length === 0) return Promise.resolve([]);
    return this.database.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.channel, 'smpp'),
          isNull(messages.receiptSentAt),
          inArray(messages.clientId, [...clientIds]),
          inArray(messages.status, ['delivered', 'read', 'failed']),
          gte(messages.createdAt, since),
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(limit);
  }

  /** Клиент принял отчёт (`deliver_sm_resp`): больше не отдаём. */
  async markReceiptSent(id: MessageId, at: Date): Promise<void> {
    await this.database.db
      .update(messages)
      .set({ receiptSentAt: at })
      .where(and(eq(messages.id, id), isNull(messages.receiptSentAt)));
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
