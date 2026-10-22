/**
 * Требования клиента к аккаунтам MAX и его ручные отключения
 * ([ADR-0092](../../../../../docs/adr/0092-trebovaniya-klienta-k-akkauntam.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import {
  clientAccountExclusions,
  clientMessageRequirements,
  messengerAccounts,
} from '@zvonix/db/schema';
import {
  newId,
  type Id,
  type MessageBusyMode,
  type MoneyAmount,
  type StopLineRequirement,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type RequirementsRow = typeof clientMessageRequirements.$inferSelect;

export interface RequirementsInput {
  readonly stopLine: StopLineRequirement;
  readonly recommendedOnly: boolean;
  readonly maxPrice: MoneyAmount | null;
  readonly minAgeDays: number | null;
}

/** Рабочий аккаунт для таблицы клиента: без названия, номера и провайдера — их клиент не видит (ADR-0014). */
export interface OfferedAccount {
  readonly id: Id<'messengerAccount'>;
  readonly partnerId: Id<'partner'>;
  /** Порядковый номер у партнёра по дате заведения: «аккаунт 3». */
  readonly number: number;
  readonly price: MoneyAmount;
  readonly stopLine: boolean;
  readonly recommended: boolean;
  readonly createdAt: Date;
}

@Injectable()
export class RequirementsRepository {
  constructor(private readonly database: DatabaseService) {}

  async find(clientId: Id<'client'>): Promise<RequirementsRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(clientMessageRequirements)
      .where(eq(clientMessageRequirements.clientId, clientId));
    return row;
  }

  async save(clientId: Id<'client'>, input: RequirementsInput): Promise<RequirementsRow> {
    const values = { ...input, updatedAt: new Date() };
    const [row] = await this.database.db
      .insert(clientMessageRequirements)
      .values({ id: newId<'clientMessageRequirements'>(), clientId, ...values })
      .onConflictDoUpdate({ target: clientMessageRequirements.clientId, set: values })
      .returning();
    if (row === undefined) throw new Error('Требования клиента не записаны');
    return row;
  }

  /** «Если отправить сразу нельзя» и «сколько ждать» (ADR-0097) — только эти поля, требования к аккаунтам не трогаются. */
  async saveDelivery(
    clientId: Id<'client'>,
    delivery: { busyMode: MessageBusyMode | null; maxWaitMinutes: number | null },
  ): Promise<void> {
    const values = { ...delivery, updatedAt: new Date() };
    await this.database.db
      .insert(clientMessageRequirements)
      .values({ id: newId<'clientMessageRequirements'>(), clientId, ...values })
      .onConflictDoUpdate({ target: clientMessageRequirements.clientId, set: values });
  }

  async exclusions(clientId: Id<'client'>): Promise<Id<'messengerAccount'>[]> {
    const rows = await this.database.db
      .select({ accountId: clientAccountExclusions.accountId })
      .from(clientAccountExclusions)
      .where(eq(clientAccountExclusions.clientId, clientId));
    return rows.map((row) => row.accountId);
  }

  /** Отключить или вернуть аккаунт; `true` — что-то изменилось. */
  async setExclusion(
    clientId: Id<'client'>,
    accountId: Id<'messengerAccount'>,
    excluded: boolean,
  ): Promise<boolean> {
    if (excluded) {
      const inserted = await this.database.db
        .insert(clientAccountExclusions)
        .values({ id: newId<'clientAccountExclusion'>(), clientId, accountId })
        .onConflictDoNothing()
        .returning({ id: clientAccountExclusions.id });
      return inserted.length > 0;
    }
    const removed = await this.database.db
      .delete(clientAccountExclusions)
      .where(
        and(
          eq(clientAccountExclusions.clientId, clientId),
          eq(clientAccountExclusions.accountId, accountId),
        ),
      )
      .returning({ id: clientAccountExclusions.id });
    return removed.length > 0;
  }

  /** Рабочие аккаунты с ценой — кандидаты для клиента; статус партнёра проверяет сервис. */
  async offered(): Promise<OfferedAccount[]> {
    const rows = await this.database.db
      .select({
        id: messengerAccounts.id,
        partnerId: messengerAccounts.partnerId,
        number:
          sql<number>`row_number() over (partition by ${messengerAccounts.partnerId} order by ${messengerAccounts.createdAt}, ${messengerAccounts.id})`.mapWith(
            Number,
          ),
        price: messengerAccounts.price,
        stopLine: messengerAccounts.stopLine,
        recommended: messengerAccounts.recommended,
        createdAt: messengerAccounts.createdAt,
        status: messengerAccounts.status,
      })
      .from(messengerAccounts)
      .where(sql`${messengerAccounts.status} <> 'retired'`)
      .orderBy(asc(messengerAccounts.price), asc(messengerAccounts.createdAt));
    return rows.flatMap((row) =>
      row.status === 'active' && row.price !== null
        ? [
            {
              id: row.id,
              partnerId: row.partnerId,
              number: row.number,
              price: row.price,
              stopLine: row.stopLine,
              recommended: row.recommended,
              createdAt: row.createdAt,
            },
          ]
        : [],
    );
  }

  /** Аккаунт существует и не выведен — его можно отключить. */
  async accountExists(accountId: Id<'messengerAccount'>): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: messengerAccounts.id })
      .from(messengerAccounts)
      .where(and(eq(messengerAccounts.id, accountId), isNotNull(messengerAccounts.partnerId)))
      .limit(1);
    return row !== undefined;
  }
}
