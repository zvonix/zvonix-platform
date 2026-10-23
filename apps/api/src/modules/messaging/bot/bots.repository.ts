/**
 * Боты MAX, подключения клиентов и подписчики
 * ([ADR-0077](../../../../../../docs/adr/0077-bot-max-vtoroy-kanal.md)).
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { toDatabaseError } from '@zvonix/db';
import {
  botConnections,
  botSubscriberEvents,
  botSubscribers,
  clients,
  messengerBots,
} from '@zvonix/db/schema';
import {
  newId,
  type BotKind,
  type BotStatus,
  type BotSubscriberEventKind,
  type Id,
  type MoneyAmount,
} from '@zvonix/shared';
import type { Executor } from '@zvonix/db';
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

  /** Свой бот клиента (ADR-0077, этап 2): у клиента он не больше одного. */
  async findClientBot(clientId: Id<'client'>): Promise<BotRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(messengerBots)
      .where(and(eq(messengerBots.kind, 'client'), eq(messengerBots.clientId, clientId)));
    return row;
  }

  /** Записывает бота клиента: первый раз вставляет, потом заменяет токен и данные (тот же `id`). */
  async saveClientBot(draft: {
    id: BotId;
    clientId: Id<'client'>;
    token: string;
    botUserId: string;
    name: string;
    username: string;
  }): Promise<BotRow> {
    try {
      const [row] = await this.database.db
        .insert(messengerBots)
        .values({ ...draft, kind: 'client', status: 'active', lastCheckedAt: new Date() })
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

  /** Работающие боты — площадки и клиентов: их подписку на события площадка поддерживает сама. */
  async listActiveBots(): Promise<BotRow[]> {
    return this.database.db.select().from(messengerBots).where(eq(messengerBots.status, 'active'));
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

  /** Настройки бота клиента: `undefined` — не трогать, `null` у текста — вернуть стандартный. */
  async setConnectionSettings(
    clientId: Id<'client'>,
    patch: {
      greeting?: string | null;
      fallbackAccounts?: boolean;
    },
  ): Promise<BotConnectionRow | undefined> {
    const [row] = await this.database.db
      .update(botConnections)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(botConnections.clientId, clientId))
      .returning();
    return row;
  }

  /** Подключение клиента теперь работает через другого бота (свой или площадки); включается. */
  async setConnectionBot(
    clientId: Id<'client'>,
    botId: BotId,
  ): Promise<BotConnectionRow | undefined> {
    const [row] = await this.database.db
      .update(botConnections)
      .set({ botId, enabled: true, updatedAt: new Date() })
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
  async listFeeDue(
    period: string,
    limit: number,
  ): Promise<{ connection: BotConnectionRow; kind: BotKind }[]> {
    return this.database.db
      .select({ connection: botConnections, kind: messengerBots.kind })
      .from(botConnections)
      .innerJoin(messengerBots, eq(messengerBots.id, botConnections.botId))
      .where(
        and(
          eq(botConnections.enabled, true),
          or(isNull(botConnections.feePaidPeriod), ne(botConnections.feePaidPeriod, period)),
        ),
      )
      .orderBy(asc(botConnections.createdAt))
      .limit(limit);
  }

  /** Подключения клиентов к ботам (площадки и свои) с названием клиента и числом подписчиков — для администратора. */
  async listConnections(): Promise<
    {
      connection: BotConnectionRow;
      clientName: string;
      subscribers: number;
      kind: BotKind;
      username: string;
    }[]
  > {
    return this.database.db
      .select({
        connection: botConnections,
        clientName: clients.name,
        kind: messengerBots.kind,
        username: messengerBots.username,
        subscribers: sql<number>`(select count(*) from bot_subscribers s where s.client_id = ${botConnections.clientId} and s.bot_id = ${botConnections.botId})::int`,
      })
      .from(botConnections)
      .innerJoin(clients, eq(clients.id, botConnections.clientId))
      .innerJoin(messengerBots, eq(messengerBots.id, botConnections.botId))
      .orderBy(asc(clients.name));
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
    /** Имя из профиля MAX, если человек его прислал (ADR-0087). */
    firstName?: string | null;
  }): Promise<BotSubscriberRow> {
    return this.database.db.transaction(async (tx) => {
      // Прежнее состояние — до записи: новое (`started`), вернулся после остановки (`restarted`), повторный запуск — без события.
      const [before] = await tx
        .select({ state: botSubscribers.state })
        .from(botSubscribers)
        .where(
          and(
            eq(botSubscribers.botId, draft.botId),
            eq(botSubscribers.clientId, draft.clientId),
            eq(botSubscribers.maxUserId, draft.maxUserId),
          ),
        )
        .for('update');
      const { inserted, ...row } = await this.upsertSubscriber(tx, draft);
      // «Новая ли» — из самой вставки, а не из чтения: MAX повторяет доставку, и два одновременных первых запуска иначе дали бы
      // два `started`.
      const kind: BotSubscriberEventKind | undefined = inserted
        ? 'started'
        : before?.state === 'stopped'
          ? 'restarted'
          : undefined;
      if (kind !== undefined) await this.recordEvents(tx, [row], kind);
      return row;
    });
  }

  private async upsertSubscriber(
    tx: Executor,
    draft: Parameters<BotsRepository['startSubscriber']>[0],
  ): Promise<BotSubscriberRow & { inserted: boolean }> {
    const [row] = await tx
      .insert(botSubscribers)
      .values({ id: newId<'botSubscriber'>(), ...draft })
      .onConflictDoUpdate({
        target: [botSubscribers.botId, botSubscribers.clientId, botSubscribers.maxUserId],
        set: {
          chatId: draft.chatId,
          state: 'started',
          updatedAt: new Date(),
          // Прежнее имя не затирается пустым: при возврате после «СТОП» MAX может не прислать профиль.
          ...(draft.firstName === undefined || draft.firstName === null
            ? {}
            : { firstName: draft.firstName }),
        },
      })
      // `xmax = 0` — строка вставлена, а не обновлена (PostgreSQL).
      .returning({ ...getTableColumns(botSubscribers), inserted: sql<boolean>`(xmax = 0)` });
    if (row === undefined) throw new Error('Подписчик не записан');
    return row;
  }

  /**
   * Человек поделился номером: он относится ко всем его подпискам в этом боте. Возвращает число подписок. Событие
   * `phone_shared` — только у подписок, где номера ещё не было (ADR-0099).
   */
  async setPhone(botId: BotId, maxUserId: string, phone: string): Promise<number> {
    return this.database.db.transaction(async (tx) => {
      const where = and(eq(botSubscribers.botId, botId), eq(botSubscribers.maxUserId, maxUserId));
      const first = await tx
        .select()
        .from(botSubscribers)
        .where(and(where, isNull(botSubscribers.phone)))
        .for('update');
      const rows = await tx
        .update(botSubscribers)
        .set({ phone, updatedAt: new Date() })
        .where(where)
        .returning({ id: botSubscribers.id });
      await this.recordEvents(tx, first, 'phone_shared');
      return rows.length;
    });
  }

  /** «СТОП» или остановка бота: все подписки человека в этом боте перестают получать сообщения; событие — у живых. */
  async stopUser(botId: BotId, maxUserId: string): Promise<void> {
    await this.stopWhere(
      and(eq(botSubscribers.botId, botId), eq(botSubscribers.maxUserId, maxUserId)),
    );
  }

  private async stopWhere(where: ReturnType<typeof and>): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const stopped = await tx
        .update(botSubscribers)
        .set({ state: 'stopped', updatedAt: new Date() })
        .where(and(where, eq(botSubscribers.state, 'started')))
        .returning();
      await this.recordEvents(tx, stopped, 'stopped');
    });
  }

  private async recordEvents(
    tx: Executor,
    subscribers: readonly Pick<BotSubscriberRow, 'id' | 'clientId' | 'botId'>[],
    kind: BotSubscriberEventKind,
  ): Promise<void> {
    if (subscribers.length === 0) return;
    await tx.insert(botSubscriberEvents).values(
      subscribers.map((subscriber) => ({
        id: newId<'botSubscriberEvent'>(),
        subscriberId: subscriber.id,
        clientId: subscriber.clientId,
        botId: subscriber.botId,
        kind,
      })),
    );
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
    botId: BotId,
    phone: string,
  ): Promise<BotSubscriberRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(botSubscribers)
      .where(
        and(
          eq(botSubscribers.clientId, clientId),
          eq(botSubscribers.botId, botId),
          eq(botSubscribers.phone, phone),
          eq(botSubscribers.state, 'started'),
        ),
      );
    return row;
  }

  /** Имя человека с этим номером у клиента — для приветствия: то, что он сам прислал боту. Нет — `null`. */
  async nameOf(clientId: Id<'client'>, phone: string): Promise<string | null> {
    const [row] = await this.database.db
      .select({ firstName: botSubscribers.firstName })
      .from(botSubscribers)
      .where(
        and(
          eq(botSubscribers.clientId, clientId),
          eq(botSubscribers.phone, phone),
          isNotNull(botSubscribers.firstName),
        ),
      )
      .orderBy(desc(botSubscribers.updatedAt))
      .limit(1);
    return row?.firstName ?? null;
  }

  /** Подписчик перестал принимать сообщения бота (остановил бота в MAX): дальше ему не пишем. */
  async stopSubscriber(id: BotSubscriberRow['id']): Promise<void> {
    await this.stopWhere(eq(botSubscribers.id, id));
  }

  /**
   * Сколько у клиента подписчиков сейчас (остановившие не считаются — раньше считались, и число в карточке бота было завышено)
   * и сколько из них уже сообщили номер.
   */
  async countFor(
    clientId: Id<'client'>,
    botId?: BotId,
  ): Promise<{ total: number; withPhone: number }> {
    const [row] = await this.database.db
      .select({
        total: sql<number>`count(*) filter (where ${botSubscribers.state} = 'started')`.mapWith(
          Number,
        ),
        withPhone:
          sql<number>`count(*) filter (where ${botSubscribers.phone} is not null and ${botSubscribers.state} = 'started')`.mapWith(
            Number,
          ),
      })
      .from(botSubscribers)
      .where(
        and(
          eq(botSubscribers.clientId, clientId),
          botId === undefined ? undefined : eq(botSubscribers.botId, botId),
        ),
      );
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
