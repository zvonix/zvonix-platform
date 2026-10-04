/**
 * Аккаунты MAX: хранение ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, lt, ne, or, isNull } from 'drizzle-orm';
import { toDatabaseError } from '@zvonix/db';
import { messengerAccounts } from '@zvonix/db/schema';
import { newId, type Id, type MessengerAccountStatus, type MoneyAmount } from '@zvonix/shared';
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

  async setTerms(
    id: MessengerAccountId,
    terms: {
      label?: string;
      price?: MoneyAmount | null;
      limitPerMinute?: number | null;
      limitPerDay?: number | null;
    },
  ): Promise<MessengerAccountRow | undefined> {
    const [row] = await this.database.db
      .update(messengerAccounts)
      .set({
        ...(terms.label === undefined ? {} : { label: terms.label }),
        ...(terms.price === undefined ? {} : { price: terms.price }),
        ...(terms.limitPerMinute === undefined ? {} : { limitPerMinute: terms.limitPerMinute }),
        ...(terms.limitPerDay === undefined ? {} : { limitPerDay: terms.limitPerDay }),
      })
      .where(and(eq(messengerAccounts.id, id), ne(messengerAccounts.status, 'retired')))
      .returning();
    return row;
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
