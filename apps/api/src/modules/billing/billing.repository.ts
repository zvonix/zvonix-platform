/**
 * Запросы к счетам и журналу проводок (ADR-0010).
 *
 * Все методы принимают исполнителя запроса: одна и та же выборка нужна и снаружи
 * транзакции, и внутри неё. Проведение операции обязано быть атомарным целиком —
 * вставка операции, вставка проводок и правка остатков либо происходят все,
 * либо не происходит ничего.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { toDatabaseError, type Database } from '@zvonix/db';
import {
  accounts,
  clients,
  ledgerEntries,
  ledgerTransactions,
  partnerAliases,
  partners,
} from '@zvonix/db/schema';
import {
  newId,
  type AccountKind,
  type ClientStatus,
  type Id,
  type MoneyAmount,
  type PartnerStatus,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

/** Исполнитель запроса: само подключение либо открытая транзакция. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export type AccountId = Id<'account'>;
export type ClientId = Id<'client'>;
export type PartnerId = Id<'partner'>;
export type UserId = Id<'user'>;

export type AccountRow = typeof accounts.$inferSelect;
export type ClientRow = typeof clients.$inferSelect;
export type PartnerRow = typeof partners.$inferSelect;
export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;
export type LedgerTransactionRow = typeof ledgerTransactions.$inferSelect;

@Injectable()
export class BillingRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Подключение по умолчанию — для чтения вне транзакции. */
  get db(): Database {
    return this.database.db;
  }

  // --- Участники -------------------------------------------------------------

  async createClient(draft: {
    ownerUserId: UserId;
    name: string;
    status: ClientStatus;
    overdraftLimit: MoneyAmount;
  }): Promise<ClientRow> {
    try {
      const [row] = await this.db
        .insert(clients)
        .values({ id: newId<'client'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findClient(id: ClientId): Promise<ClientRow | undefined> {
    const [row] = await this.db.select().from(clients).where(eq(clients.id, id));
    return row;
  }

  async listClients(): Promise<ClientRow[]> {
    return this.db.select().from(clients).orderBy(asc(clients.name));
  }

  async createPartner(draft: {
    ownerUserId: UserId;
    name: string;
    status: PartnerStatus;
  }): Promise<PartnerRow> {
    try {
      const [row] = await this.db
        .insert(partners)
        .values({ id: newId<'partner'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findPartner(id: PartnerId): Promise<PartnerRow | undefined> {
    const [row] = await this.db.select().from(partners).where(eq(partners.id, id));
    return row;
  }

  /** Псевдоним, под которым партнёра видит клиент (ADR-0014). Настоящее имя не отдаётся. */
  async setPartnerAlias(partnerId: PartnerId, displayName: string): Promise<string> {
    try {
      await this.db
        .insert(partnerAliases)
        .values({ id: newId<'partnerAlias'>(), partnerId, displayName });
      return displayName;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findPartnerAlias(partnerId: PartnerId): Promise<string | undefined> {
    const [row] = await this.db
      .select({ displayName: partnerAliases.displayName })
      .from(partnerAliases)
      .where(eq(partnerAliases.partnerId, partnerId));
    return row?.displayName;
  }

  // --- Счета -----------------------------------------------------------------

  async findAccount(
    kind: AccountKind,
    ownerId: string | null,
    currency: string,
    executor: Executor = this.db,
  ): Promise<AccountRow | undefined> {
    const [row] = await executor
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.kind, kind),
          ownerId === null ? sql`${accounts.ownerId} is null` : eq(accounts.ownerId, ownerId),
          eq(accounts.currency, currency),
        ),
      );
    return row;
  }

  /**
   * Заводит счёт, если его ещё нет.
   *
   * Гонку закрывает уникальный индекс, а не проверка перед вставкой: два одновременных
   * первых списания иначе завели бы два счёта одному владельцу, и остаток разъехался бы
   * на два несходящихся.
   */
  async ensureAccount(
    kind: AccountKind,
    ownerId: string | null,
    currency: string,
  ): Promise<AccountRow> {
    const existing = await this.findAccount(kind, ownerId, currency);
    if (existing !== undefined) return existing;

    try {
      const [created] = await this.db
        .insert(accounts)
        .values({ id: newId<'account'>(), kind, ownerId, currency })
        .onConflictDoNothing()
        .returning();
      if (created !== undefined) return created;
    } catch (cause) {
      throw toDatabaseError(cause);
    }

    const after = await this.findAccount(kind, ownerId, currency);
    if (after === undefined) throw new Error('Счёт не создан и не найден');
    return after;
  }

  /**
   * Блокирует счета до конца транзакции, в порядке идентификаторов.
   *
   * Порядок обязателен: две операции, затрагивающие одни и те же счета в разном порядке,
   * иначе встанут во взаимную блокировку. Упорядочивание по идентификатору делает
   * порядок захвата одинаковым для всех.
   */
  async lockAccounts(ids: readonly AccountId[], executor: Executor): Promise<AccountRow[]> {
    if (ids.length === 0) return [];
    return executor
      .select()
      .from(accounts)
      .where(inArray(accounts.id, [...ids]))
      .orderBy(asc(accounts.id))
      .for('update');
  }

  async adjustBalance(id: AccountId, delta: MoneyAmount, executor: Executor): Promise<MoneyAmount> {
    const [row] = await executor
      .update(accounts)
      .set({ balance: sql`${accounts.balance} + ${delta}`, updatedAt: new Date() })
      .where(eq(accounts.id, id))
      .returning({ balance: accounts.balance });
    if (row === undefined) throw new Error('Обновление остатка не вернуло строку');
    return row.balance;
  }

  // --- Журнал ----------------------------------------------------------------

  async findTransactionByKey(
    idempotencyKey: string,
    executor: Executor = this.db,
  ): Promise<LedgerTransactionRow | undefined> {
    const [row] = await executor
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, idempotencyKey));
    return row;
  }

  /** Вставляет операцию. `undefined` означает, что операция с таким ключом уже была. */
  async insertTransaction(
    draft: typeof ledgerTransactions.$inferInsert,
    executor: Executor,
  ): Promise<LedgerTransactionRow | undefined> {
    try {
      const [row] = await executor
        .insert(ledgerTransactions)
        .values(draft)
        .onConflictDoNothing({ target: ledgerTransactions.idempotencyKey })
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async insertEntries(
    rows: readonly (typeof ledgerEntries.$inferInsert)[],
    executor: Executor,
  ): Promise<LedgerEntryRow[]> {
    try {
      return await executor
        .insert(ledgerEntries)
        .values([...rows])
        .returning();
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async listEntries(accountId: AccountId, limit: number): Promise<LedgerEntryRow[]> {
    return this.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, accountId))
      .orderBy(desc(ledgerEntries.seq))
      .limit(limit);
  }

  async listTransactionEntries(transactionId: Id<'ledgerTransaction'>): Promise<LedgerEntryRow[]> {
    return this.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, transactionId))
      .orderBy(asc(ledgerEntries.seq));
  }

  /**
   * Сверка: материализованный остаток против суммы проводок по каждому счёту.
   *
   * Возвращает только расхождения. Пустой список — норма; непустой означает инцидент
   * и разбор, а не тихую коррекцию: если остаток разошёлся, важно понять почему,
   * а не подогнать число.
   */
  async findBalanceDiscrepancies(): Promise<
    { accountId: AccountId; stored: bigint; computed: bigint }[]
  > {
    const result = await this.db.execute<{
      account_id: AccountId;
      stored: string;
      computed: string;
    }>(sql`
      select a.id as account_id,
             a.balance as stored,
             coalesce(sum(e.amount), 0) as computed
        from accounts a
        left join ledger_entries e on e.account_id = a.id
       group by a.id, a.balance
      having a.balance <> coalesce(sum(e.amount), 0)
    `);

    return result.rows.map((row) => ({
      accountId: row.account_id,
      stored: BigInt(row.stored),
      computed: BigInt(row.computed),
    }));
  }
}
