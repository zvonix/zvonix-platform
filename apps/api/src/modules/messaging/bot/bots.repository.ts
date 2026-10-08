/**
 * Боты MAX, подключения клиентов и подписчики
 * ([ADR-0077](../../../../../../docs/adr/0077-bot-max-vtoroy-kanal.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { toDatabaseError } from '@zvonix/db';
import { botConnections, botSubscribers, clients, messengerBots } from '@zvonix/db/schema';
import { newId, type BotStatus, type Id, type MoneyAmount } from '@zvonix/shared';
import { DatabaseService } from '../../../infra/database.service.js';

export type BotRow = typeof messengerBots.$inferSelect;
export type BotConnectionRow = typeof botConnections.$inferSelect;
export type BotSubscriberRow = typeof botSubscribers.$inferSelect;
export type BotId = Id<'messengerBot'>;

@Injectable()
export class BotsRepository {
  constructor(private readonly database: DatabaseService) {}

  newBotId(): BotId {
    return newId<'messengerBot'>();
  }

  async findPlatformBot(): Promise<BotRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(messengerBots)
      .where(eq(messengerBots.kind, 'platform'));
    return row;
  }

  async findBot(id: BotId): Promise<BotRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(messengerBots)
      .where(eq(messengerBots.id, id));
    return row;
  }

  /** Записывает бота площадки: первый раз вставляет, потом заменяет токен и данные (тот же `id`). */
  async savePlatformBot(draft: {
    id: BotId;
    token: string;
    botUserId: string;
    name: string;
    username: string;
  }): Promise<BotRow> {
    try {
      const [row] = await this.database.db
        .insert(messengerBots)
        .values({ ...draft, kind: 'platform', status: 'active', lastCheckedAt: new Date() })
        .onConflictDoUpdate({
          target: messengerBots.id,
          set: {
            token: draft.token,
            botUserId: draft.botUserId,
            name: draft.name,
            username: draft.username,
            status: 'active',
            lastError: null,
            lastCheckedAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .returning();
      if (row === undefined) throw new Error('Бот не записан');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async setBotState(
    id: BotId,
    patch: { status?: BotStatus; lastError?: string | null },
  ): Promise<BotRow | undefined> {
    const [row] = await this.database.db
      .update(messengerBots)
      .set({ ...patch, lastCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(messengerBots.id, id))
      .returning();
    return row;
  }

  // --- Подключения клиентов -----------------------------------------------------------------

  async findConnectionByClient(clientId: Id<'client'>): Promise<BotConnectionRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(botConnections)
      .where(eq(botConnections.clientId, clientId));
    return row;
  }

  async findConnectionByCode(code: string): Promise<BotConnectionRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(botConnections)
      .where(eq(botConnections.code, code));
    return row;
  }

  async insertConnection(draft: {
    clientId: Id<'client'>;
    botId: BotId;
    code: string;
    feePaidPeriod: string | null;
  }): Promise<BotConnectionRow> {
    try {
      const [row] = await this.database.db
        .insert(botConnections)
        .values({ id: newId<'botConnection'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Подключение к боту не записано');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /** Условия клиента: `undefined` — не трогать, `null` — вернуть к общим настройкам. */
  async setConnectionPrices(
    clientId: Id<'client'>,
    patch: { messagePrice?: MoneyAmount | null; monthlyFee?: MoneyAmount | null },
  ): Promise<BotConnectionRow | undefined> {
    const [row] = await this.database.db
      .update(botConnections)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(botConnections.clientId, clientId))
      .returning();
    return row;
  }

  /** Плата за этот месяц взята. */
  async markFeePaid(clientId: Id<'client'>, period: string): Promise<void> {
    await this.database.db
      .update(botConnections)
      .set({ feePaidPeriod: period, updatedAt: new Date() })
      .where(eq(botConnections.clientId, clientId));
  }

  /** Включённые подключения, за которые плата за месяц ещё не взята: воркер пробует взять. */
  async listFeeDue(period: string, limit: number): Promise<BotConnectionRow[]> {
    return this.database.db
      .select()
      .from(botConnections)
      .where(
        and(
          eq(botConnections.enabled, true),
          or(isNull(botConnections.feePaidPeriod), ne(botConnections.feePaidPeriod, period)),
        ),
      )
      .orderBy(asc(botConnections.createdAt))
      .limit(limit);
  }

  /** Подключения клиентов к боту с названием клиента и числом подписчиков — для администратора. */
  async listConnections(botId: BotId): Promise<
    {
      connection: BotConnectionRow;
      clientName: string;
      subscribers: number;
    }[]
  > {
    const rows = await this.database.db
      .select({
        connection: botConnections,
        clientName: clients.name,
        subscribers: sql<number>`(select count(*) from bot_subscribers s where s.client_id = ${botConnections.clientId} and s.bot_id = ${botConnections.botId})::int`,
      })
      .from(botConnections)
      .innerJoin(clients, eq(clients.id, botConnections.clientId))
      .where(eq(botConnections.botId, botId))
      .orderBy(asc(clients.name));
    return rows;
  }

  async setConnectionEnabled(
    clientId: Id<'client'>,
    enabled: boolean,
  ): Promise<BotConnectionRow | undefined> {
    const [row] = await this.database.db
      .update(botConnections)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(botConnections.clientId, clientId))
      .returning();
    return row;
  }

  // --- Подписчики ------------------------------------------------------------------------------

  /** Человек запустил бота по ссылке клиента (или вернулся после «СТОП»). */
  async startSubscriber(draft: {
    botId: BotId;
    clientId: Id<'client'>;
    maxUserId: string;
    chatId: string;
  }): Promise<BotSubscriberRow> {
    const [row] = await this.database.db
      .insert(botSubscribers)
      .values({ id: newId<'botSubscriber'>(), ...draft })
      .onConflictDoUpdate({
        target: [botSubscribers.botId, botSubscribers.clientId, botSubscribers.maxUserId],
        set: { chatId: draft.chatId, state: 'started', updatedAt: new Date() },
      })
      .returning();
    if (row === undefined) throw new Error('Подписчик не записан');
    return row;
  }

  /** Человек поделился номером: он относится ко всем его подпискам в этом боте. Возвращает число подписок. */
  async setPhone(botId: BotId, maxUserId: string, phone: string): Promise<number> {
    const rows = await this.database.db
      .update(botSubscribers)
      .set({ phone, updatedAt: new Date() })
      .where(and(eq(botSubscribers.botId, botId), eq(botSubscribers.maxUserId, maxUserId)))
      .returning({ id: botSubscribers.id });
    return rows.length;
  }

  /** «СТОП»: все подписки человека в этом боте перестают получать сообщения. */
  async stopUser(botId: BotId, maxUserId: string): Promise<void> {
    await this.database.db
      .update(botSubscribers)
      .set({ state: 'stopped', updatedAt: new Date() })
      .where(and(eq(botSubscribers.botId, botId), eq(botSubscribers.maxUserId, maxUserId)));
  }

  async subscribersOf(botId: BotId, maxUserId: string): Promise<BotSubscriberRow[]> {
    return this.database.db
      .select()
      .from(botSubscribers)
      .where(and(eq(botSubscribers.botId, botId), eq(botSubscribers.maxUserId, maxUserId)));
  }

  /** Живой подписчик клиента с этим номером: ему можно писать ботом. */
  async findReachable(
    clientId: Id<'client'>,
    phone: string,
  ): Promise<BotSubscriberRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(botSubscribers)
      .where(
        and(
          eq(botSubscribers.clientId, clientId),
          eq(botSubscribers.phone, phone),
          eq(botSubscribers.state, 'started'),
        ),
      );
    return row;
  }

  /** Подписчик перестал принимать сообщения бота (остановил бота в MAX): дальше ему не пишем. */
  async stopSubscriber(id: BotSubscriberRow['id']): Promise<void> {
    await this.database.db
      .update(botSubscribers)
      .set({ state: 'stopped', updatedAt: new Date() })
      .where(eq(botSubscribers.id, id));
  }

  /** Сколько у клиента подписчиков всего и сколько из них уже сообщили номер. */
  async countFor(clientId: Id<'client'>): Promise<{ total: number; withPhone: number }> {
    const [row] = await this.database.db
      .select({
        total: count(),
        withPhone:
          sql<number>`count(*) filter (where ${botSubscribers.phone} is not null and ${botSubscribers.state} = 'started')`.mapWith(
            Number,
          ),
      })
      .from(botSubscribers)
      .where(eq(botSubscribers.clientId, clientId));
    return { total: row?.total ?? 0, withPhone: row?.withPhone ?? 0 };
  }

  /** Для администратора: сколько клиентов подключено к боту и сколько у него подписчиков. */
  async totals(botId: BotId): Promise<{ clients: number; subscribers: number }> {
    const [clients] = await this.database.db
      .select({ n: count() })
      .from(botConnections)
      .where(and(eq(botConnections.botId, botId), eq(botConnections.enabled, true)));
    const [subscribers] = await this.database.db
      .select({ n: count() })
      .from(botSubscribers)
      .where(eq(botSubscribers.botId, botId));
    return { clients: clients?.n ?? 0, subscribers: subscribers?.n ?? 0 };
  }
}
