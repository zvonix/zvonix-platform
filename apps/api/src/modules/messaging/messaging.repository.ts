/**
 * Аккаунты MAX: хранение ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, lt, ne, or, isNull, sql } from 'drizzle-orm';
import { toDatabaseError, type Executor } from '@zvonix/db';
import { messengerAccounts } from '@zvonix/db/schema';
import { newId, type Id, type MessengerAccountStatus } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type MessengerAccountRow = typeof messengerAccounts.$inferSelect;
export type MessengerAccountId = Id<'messengerAccount'>;

@Injectable()
export class MessagingRepository {
  constructor(private readonly database: DatabaseService) {}

  async insert(draft: {
    partnerId: Id<'partner'>;
    label: string;
    provider: MessengerAccountRow['provider'];
    providerInstanceId: string;
    providerToken: string;
    providerApiUrl: string;
  }): Promise<MessengerAccountRow> {
    try {
      const [row] = await this.database.db
        .insert(messengerAccounts)
        .values({ id: newId<'messengerAccount'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Аккаунт не вставлен');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findByInstance(
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

  async findById(id: MessengerAccountId): Promise<MessengerAccountRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(messengerAccounts)
      .where(eq(messengerAccounts.id, id));
    return row;
  }

  /** Аккаунты партнёра, кроме списанных, старые первыми. */
  listOfPartner(partnerId: Id<'partner'>): Promise<MessengerAccountRow[]> {
    return this.database.db
      .select()
      .from(messengerAccounts)
      .where(
        and(eq(messengerAccounts.partnerId, partnerId), ne(messengerAccounts.status, 'retired')),
      )
      .orderBy(asc(messengerAccounts.createdAt), asc(messengerAccounts.id));
  }

  /** Все живые аккаунты площадки — для администратора. */
  listLive(): Promise<MessengerAccountRow[]> {
    return this.database.db
      .select()
      .from(messengerAccounts)
      .where(ne(messengerAccounts.status, 'retired'))
      .orderBy(asc(messengerAccounts.createdAt), asc(messengerAccounts.id));
  }

  async countLiveOfPartner(partnerId: Id<'partner'>): Promise<number> {
    const [row] = await this.database.db
      .select({ total: count() })
      .from(messengerAccounts)
      .where(
        and(eq(messengerAccounts.partnerId, partnerId), ne(messengerAccounts.status, 'retired')),
      );
    return row?.total ?? 0;
  }

  /**
   * Живые аккаунты, состояние которых давно не сверялось, — по сроку, а не «с прошлого запуска»
   * ([ADR-0020](../../../../../docs/adr/0020-fonovye-zadachi.md)).
   */
  listDueForCheck(before: Date, limit: number): Promise<MessengerAccountRow[]> {
    return this.database.db
      .select()
      .from(messengerAccounts)
      .where(
        and(
          ne(messengerAccounts.status, 'retired'),
          or(
            isNull(messengerAccounts.stateCheckedAt),
            lt(messengerAccounts.stateCheckedAt, before),
          ),
        ),
      )
      .orderBy(asc(messengerAccounts.stateCheckedAt))
      .limit(limit);
  }

  /** Состояние и номер по итогам сверки с провайдером. `retired` не трогается — из него не выходят. */
  async setState(
    id: MessengerAccountId,
    state: { status: MessengerAccountStatus; phone: string | null; checkedAt: Date },
  ): Promise<MessengerAccountRow | undefined> {
    const [row] = await this.database.db
      .update(messengerAccounts)
      .set({
        status: state.status,
        phone: state.phone,
        stateCheckedAt: state.checkedAt,
      })
      .where(and(eq(messengerAccounts.id, id), ne(messengerAccounts.status, 'retired')))
      .returning();
    return row;
  }

  async setLabel(id: MessengerAccountId, label: string): Promise<MessengerAccountRow | undefined> {
    const [row] = await this.database.db
      .update(messengerAccounts)
      .set({ label })
      .where(and(eq(messengerAccounts.id, id), ne(messengerAccounts.status, 'retired')))
      .returning();
    return row;
  }

  /** Назначает аккаунту тариф (`null` — идти за умолчанием партнёра). Пересчёт условий — отдельно, в той же транзакции. */
  async setTariff(
    id: MessengerAccountId,
    tariffId: Id<'messengerTariff'> | null,
    executor: Executor = this.database.db,
  ): Promise<MessengerAccountRow | undefined> {
    const [row] = await executor
      .update(messengerAccounts)
      .set({ tariffId })
      .where(and(eq(messengerAccounts.id, id), ne(messengerAccounts.status, 'retired')))
      .returning();
    return row;
  }

  /**
   * Пересчёт действующих условий аккаунтов партнёра ([ADR-0075](../../../../../docs/adr/0075-tarify-max-nabor-uslovij.md)):
   * свой тариф → тариф по умолчанию → нет. **Единственное место, где пишутся `price` и лимиты аккаунта.**
   * Вызывается в той же транзакции, что и любое изменение тарифа, назначения или умолчания.
   */
  async recomputeTerms(
    partnerId: Id<'partner'>,
    executor: Executor = this.database.db,
  ): Promise<void> {
    await executor.execute(sql`
      update messenger_accounts a
      set price = e.price, limit_per_minute = e.limit_per_minute, limit_per_day = e.limit_per_day
      from (
        select a2.id, t.price, t.limit_per_minute, t.limit_per_day
        from messenger_accounts a2
        left join messenger_tariffs d on d.partner_id = a2.partner_id and d.is_default
        left join messenger_tariffs t on t.id = coalesce(a2.tariff_id, d.id)
        where a2.partner_id = ${partnerId} and a2.status <> 'retired'
      ) e
      where a.id = e.id
    `);
  }

  /** Списание: условное, чтобы повторное нажатие не перезаписывало. */
  async retire(id: MessengerAccountId): Promise<MessengerAccountRow | undefined> {
    const [row] = await this.database.db
      .update(messengerAccounts)
      .set({ status: 'retired' })
      .where(and(eq(messengerAccounts.id, id), ne(messengerAccounts.status, 'retired')))
      .returning();
    return row;
  }
}
