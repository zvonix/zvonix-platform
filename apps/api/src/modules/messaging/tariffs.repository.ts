/**
 * Тарифы MAX: хранение ([ADR-0075](../../../../../docs/adr/0075-tarify-max-nabor-uslovij.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, ne } from 'drizzle-orm';
import { toDatabaseError, type Executor } from '@zvonix/db';
import { messengerAccounts, messengerTariffs } from '@zvonix/db/schema';
import { newId, type Id, type MoneyAmount } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type MessengerTariffRow = typeof messengerTariffs.$inferSelect;
export type MessengerTariffId = Id<'messengerTariff'>;

export interface TariffTerms {
  readonly price: MoneyAmount;
  readonly limitPerMinute: number | null;
  readonly limitPerDay: number | null;
}

@Injectable()
export class MessengerTariffsRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Транзакция записи: тариф, умолчание и пересчёт условий аккаунтов — одним целым. */
  async transaction<T>(work: (tx: Executor) => Promise<T>): Promise<T> {
    try {
      return await this.database.db.transaction(work);
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  listOfPartner(
    partnerId: Id<'partner'>,
    executor: Executor = this.database.db,
  ): Promise<MessengerTariffRow[]> {
    return executor
      .select()
      .from(messengerTariffs)
      .where(eq(messengerTariffs.partnerId, partnerId))
      .orderBy(asc(messengerTariffs.createdAt), asc(messengerTariffs.id));
  }

  async find(
    id: MessengerTariffId,
    executor: Executor = this.database.db,
  ): Promise<MessengerTariffRow | undefined> {
    const [row] = await executor.select().from(messengerTariffs).where(eq(messengerTariffs.id, id));
    return row;
  }

  /** Сколько живых аккаунтов назначено на тариф и сколько идёт за умолчанием (без своего тарифа). */
  async usage(
    partnerId: Id<'partner'>,
    executor: Executor = this.database.db,
  ): Promise<{ assigned: Map<string, number>; followingDefault: number }> {
    const live = and(
      eq(messengerAccounts.partnerId, partnerId),
      ne(messengerAccounts.status, 'retired'),
    );
    const rows = await executor
      .select({ tariffId: messengerAccounts.tariffId, total: count() })
      .from(messengerAccounts)
      .where(live)
      .groupBy(messengerAccounts.tariffId);
    const assigned = new Map<string, number>();
    let followingDefault = 0;
    for (const row of rows) {
      if (row.tariffId === null) followingDefault += row.total;
      else assigned.set(row.tariffId, row.total);
    }
    return { assigned, followingDefault };
  }

  async insert(
    draft: TariffTerms & { partnerId: Id<'partner'>; name: string; isDefault: boolean },
    executor: Executor,
  ): Promise<MessengerTariffRow> {
    const [row] = await executor
      .insert(messengerTariffs)
      .values({ id: newId<'messengerTariff'>(), ...draft })
      .returning();
    if (row === undefined) throw new Error('Тариф не вставлен');
    return row;
  }

  async update(
    id: MessengerTariffId,
    patch: {
      name?: string;
      price?: MoneyAmount;
      limitPerMinute?: number | null;
      limitPerDay?: number | null;
    },
    executor: Executor,
  ): Promise<MessengerTariffRow | undefined> {
    const [row] = await executor
      .update(messengerTariffs)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.price === undefined ? {} : { price: patch.price }),
        ...(patch.limitPerMinute === undefined ? {} : { limitPerMinute: patch.limitPerMinute }),
        ...(patch.limitPerDay === undefined ? {} : { limitPerDay: patch.limitPerDay }),
      })
      .where(eq(messengerTariffs.id, id))
      .returning();
    return row;
  }

  /** Снимает признак «по умолчанию» у остальных тарифов партнёра: он один (частичный уникальный индекс). */
  async clearDefault(partnerId: Id<'partner'>, executor: Executor): Promise<void> {
    await executor
      .update(messengerTariffs)
      .set({ isDefault: false })
      .where(and(eq(messengerTariffs.partnerId, partnerId), eq(messengerTariffs.isDefault, true)));
  }

  async markDefault(id: MessengerTariffId, executor: Executor): Promise<void> {
    await executor
      .update(messengerTariffs)
      .set({ isDefault: true })
      .where(eq(messengerTariffs.id, id));
  }

  async remove(id: MessengerTariffId, executor: Executor): Promise<void> {
    await executor.delete(messengerTariffs).where(eq(messengerTariffs.id, id));
  }
}
