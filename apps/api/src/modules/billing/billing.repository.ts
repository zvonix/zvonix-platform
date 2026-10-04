/**
 * Запросы к счетам и журналу проводок (ADR-0010).
 *
 * Все методы принимают исполнителя запроса: одна и та же выборка нужна и снаружи
 * транзакции, и внутри неё. Проведение операции обязано быть атомарным целиком —
 * вставка операции, вставка проводок и правка остатков либо происходят все,
 * либо не происходит ничего.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  containsIgnoringCase,
  orderByText,
  toDatabaseError,
  type Database,
  type Executor,
} from '@zvonix/db';
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
  type TransactionKind,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

/** Исполнитель запроса: само подключение либо открытая транзакция. */
// Тип объявлен в `@zvonix/db` и переэкспортируется отсюда: вызывающий берёт его
// там же, где метод, а определение остаётся одно на весь проект.
export type { Executor };

export type AccountId = Id<'account'>;
export type ClientId = Id<'client'>;
export type PartnerId = Id<'partner'>;
export type UserId = Id<'user'>;

export type AccountRow = typeof accounts.$inferSelect;
export type ClientRow = typeof clients.$inferSelect;
export type PartnerRow = typeof partners.$inferSelect;
export type PartnerAliasRow = typeof partnerAliases.$inferSelect;
/** Деньги одного вызова по трём счетам его проводки. */
export interface CallCharges {
  readonly client: MoneyAmount;
  readonly partner: MoneyAmount;
  readonly revenue: MoneyAmount;
}

export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;
export type LedgerTransactionRow = typeof ledgerTransactions.$inferSelect;

/**
 * Отбор клиентов. Пустое поле означает «любое», а не «пустое».
 */
export interface ClientFilter {
  /** Одна запись — для карточки клиента. */
  readonly id?: ClientId;
  readonly status?: ClientStatus;
  /** Часть названия. Регистр не важен. */
  readonly name?: string;
  readonly limit: number;
  readonly offset: number;
}

/** Клиент вместе с остатком: в списке они нужны всегда вместе. */
export interface ClientWithBalance {
  readonly id: ClientId;
  readonly ownerUserId: UserId;
  readonly name: string;
  readonly status: ClientStatus;
  readonly overdraftLimit: MoneyAmount;
  readonly createdAt: Date;
  readonly balance: MoneyAmount;
}

/** Проводка вместе с тем, частью какой операции она была. */
export interface LedgerEntryWithTransaction {
  readonly seq: bigint;
  readonly transactionId: string;
  readonly amount: MoneyAmount;
  readonly createdAt: Date;
  readonly kind: TransactionKind;
  readonly description: string;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
}

/** Отбор партнёров. Пустое поле означает «любое», а не «пустое». */
export interface PartnerFilter {
  /** Одна запись — для карточки партнёра. */
  readonly id?: PartnerId;
  readonly status?: PartnerStatus;
  /** Часть настоящего имени либо псевдонима. Регистр не важен. */
  readonly name?: string;
  /** Только те, кому площадка должна: остаток на счёте больше нуля (список к выплате). */
  readonly owed?: boolean;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Партнёр вместе с остатком и псевдонимом — для **административного** контура.
 *
 * Настоящее имя здесь есть, и это не противоречит
 * [ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md): запрет
 * действует на клиентский контур. В клиентский контур ведёт `listOfferedAliases`,
 * и там имени нет.
 */
export interface PartnerWithBalance {
  readonly id: PartnerId;
  readonly ownerUserId: UserId;
  readonly name: string;
  readonly status: PartnerStatus;
  readonly listensToRecordings: boolean;
  readonly createdAt: Date;
  readonly balance: MoneyAmount;
  /** Псевдоним заводится вместе с партнёром, но список обязан пережить его отсутствие. */
  readonly displayName: string | null;
}

function clientFilterCondition(filter: ClientFilter): SQL | undefined {
  const parts: SQL[] = [];
  if (filter.id !== undefined) parts.push(eq(clients.id, filter.id));
  if (filter.status !== undefined) parts.push(eq(clients.status, filter.status));
  // Названия служб такси русские, и без явной локали сравнения поиск «такси»
  // не нашёл бы «Такси»: в локали `C` PostgreSQL кириллицу не приводит вовсе.
  if (filter.name !== undefined && filter.name !== '') {
    parts.push(containsIgnoringCase(clients.name, filter.name));
  }
  return parts.length === 0 ? undefined : and(...parts);
}

/**
 * Отбор партнёров.
 *
 * Поиск идёт **и по настоящему имени, и по псевдониму**: администратор помнит либо
 * то, либо другое, а требовать угадать, какое именно, — способ ничего не найти.
 */
function partnerFilterCondition(filter: PartnerFilter): SQL | undefined {
  const parts: SQL[] = [];
  if (filter.id !== undefined) parts.push(eq(partners.id, filter.id));
  if (filter.status !== undefined) parts.push(eq(partners.status, filter.status));
  if (filter.name !== undefined && filter.name !== '') {
    const found = or(
      containsIgnoringCase(partners.name, filter.name),
      containsIgnoringCase(partnerAliases.displayName, filter.name),
    );
    if (found !== undefined) parts.push(found);
  }
  if (filter.owed === true) parts.push(sql`coalesce(${accounts.balance}, 0) > 0`);
  return parts.length === 0 ? undefined : and(...parts);
}

@Injectable()
export class BillingRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Подключение по умолчанию — для чтения вне транзакции. */
  get db(): Database {
    return this.database.db;
  }

  // --- Участники -------------------------------------------------------------

  async createClient(
    draft: {
      ownerUserId: UserId;
      name: string;
      status: ClientStatus;
      overdraftLimit: MoneyAmount;
    },
    executor: Executor = this.db,
  ): Promise<ClientRow> {
    try {
      const [row] = await executor
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

  /**
   * Клиенты вместе с остатками — **одним запросом**.
   *
   * Раньше остаток спрашивался отдельно на каждого клиента: на четырёх незаметно,
   * на четырёх тысячах это четыре тысячи запросов. Соединение внешнее: у только что
   * заведённого клиента счёта может ещё не быть, и он обязан попасть в список
   * с нулём, а не пропасть из него.
   */
  async listClients(
    filter: ClientFilter,
    currency: string,
  ): Promise<{ rows: ClientWithBalance[]; total: number }> {
    const where = clientFilterCondition(filter);
    // `accounts.owner_id` — `text`: он указывает то на клиента, то на партнёра,
    // и внешним ключом это не выразить. При сравнении колонок PostgreSQL отказывается
    // сопоставлять `text` с `uuid` сам, поэтому приведение здесь явное.
    const account = and(
      eq(accounts.kind, 'client'),
      sql`${accounts.ownerId} = ${clients.id}::text`,
      eq(accounts.currency, currency),
    );

    const rows = await this.db
      .select({
        id: clients.id,
        ownerUserId: clients.ownerUserId,
        name: clients.name,
        status: clients.status,
        overdraftLimit: clients.overdraftLimit,
        createdAt: clients.createdAt,
        balance: sql<string>`coalesce(${accounts.balance}, 0)`,
      })
      .from(clients)
      .leftJoin(accounts, account)
      .where(where)
      .orderBy(orderByText(clients.name), asc(clients.id))
      .limit(filter.limit)
      .offset(filter.offset);

    const [counted] = await this.db.select({ total: count() }).from(clients).where(where);

    return {
      rows: rows.map((row) => ({ ...row, balance: BigInt(row.balance) as MoneyAmount })),
      total: counted?.total ?? 0,
    };
  }

  async createPartner(
    draft: {
      ownerUserId: UserId;
      name: string;
      status: PartnerStatus;
    },
    executor: Executor = this.db,
  ): Promise<PartnerRow> {
    try {
      const [row] = await executor
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

  /**
   * Партнёры вместе с остатком и псевдонимом — одним запросом.
   *
   * Оба соединения внешние по одной причине: список обязан показать партнёра
   * таким, какой он есть, а не прятать неполного. Партнёр без счёта или без
   * псевдонима — это как раз тот, кого администратору нужно увидеть и починить.
   */
  async listPartners(
    filter: PartnerFilter,
    currency: string,
  ): Promise<{ rows: PartnerWithBalance[]; total: number }> {
    const where = partnerFilterCondition(filter);
    // `accounts.owner_id` — `text` (он указывает то на клиента, то на партнёра),
    // поэтому приведение при сравнении колонок явное.
    const account = and(
      eq(accounts.kind, 'partner'),
      sql`${accounts.ownerId} = ${partners.id}::text`,
      eq(accounts.currency, currency),
    );

    const rows = await this.db
      .select({
        id: partners.id,
        ownerUserId: partners.ownerUserId,
        name: partners.name,
        status: partners.status,
        listensToRecordings: partners.listensToRecordings,
        createdAt: partners.createdAt,
        displayName: partnerAliases.displayName,
        balance: sql<string>`coalesce(${accounts.balance}, 0)`,
      })
      .from(partners)
      .leftJoin(partnerAliases, eq(partnerAliases.partnerId, partners.id))
      .leftJoin(accounts, account)
      .where(where)
      .orderBy(
        ...(filter.owed === true ? [desc(sql`coalesce(${accounts.balance}, 0)`)] : []),
        orderByText(partners.name),
        asc(partners.id),
      )
      .limit(filter.limit)
      .offset(filter.offset);

    // Соединение с псевдонимами повторяется и здесь: отбор по нему ссылается,
    // и счёт без соединения считал бы не то, что показывает страница.
    const [counted] = await this.db
      .select({ total: count() })
      .from(partners)
      .leftJoin(partnerAliases, eq(partnerAliases.partnerId, partners.id))
      .leftJoin(accounts, account)
      .where(where);

    return {
      rows: rows.map((row) => ({ ...row, balance: BigInt(row.balance) as MoneyAmount })),
      total: counted?.total ?? 0,
    };
  }

  /** Меняет разрешённый минус. Возвращает `undefined`, если такого клиента нет. */
  async setOverdraftLimit(id: ClientId, limit: MoneyAmount): Promise<ClientRow | undefined> {
    const [row] = await this.db
      .update(clients)
      .set({ overdraftLimit: limit, updatedAt: new Date() })
      .where(eq(clients.id, id))
      .returning();
    return row;
  }

  /** Меняет состояние клиента. Возвращает `undefined`, если такого клиента нет. */
  async setClientStatus(id: ClientId, status: ClientStatus): Promise<ClientRow | undefined> {
    const [row] = await this.db
      .update(clients)
      .set({ status, updatedAt: new Date() })
      .where(eq(clients.id, id))
      .returning();
    return row;
  }

  /** Меняет состояние партнёра. Возвращает `undefined`, если такого партнёра нет. */
  async setPartnerStatus(id: PartnerId, status: PartnerStatus): Promise<PartnerRow | undefined> {
    const [row] = await this.db
      .update(partners)
      .set({ status, updatedAt: new Date() })
      .where(eq(partners.id, id))
      .returning();
    return row;
  }

  /** Псевдоним, под которым партнёра видит клиент (ADR-0014). Настоящее имя не отдаётся. */
  async setPartnerAlias(
    partnerId: PartnerId,
    displayName: string,
    executor: Executor = this.db,
  ): Promise<string> {
    try {
      await executor
        .insert(partnerAliases)
        .values({ id: newId<'partnerAlias'>(), partnerId, displayName });
      return displayName;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Переименовывает псевдоним партнёра.
   *
   * Отдельно от вставки: у партнёра ровно один псевдоним (`partner_aliases_partner_key`),
   * поэтому «завести» и «переименовать» — разные операции, и вторая не должна создавать
   * второй псевдоним при промахе.
   */
  async renamePartnerAlias(
    partnerId: PartnerId,
    displayName: string,
  ): Promise<PartnerAliasRow | undefined> {
    try {
      const [row] = await this.db
        .update(partnerAliases)
        .set({ displayName })
        .where(eq(partnerAliases.partnerId, partnerId))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Псевдоним по его идентификатору.
   *
   * Клиентский контур оперирует **только** псевдонимами: возврат `partner_id` наружу —
   * дефект уровня инварианта (ADR-0014). Поэтому и вход тоже по псевдониму: клиент
   * называет партнёра тем единственным именем, которое о нём знает.
   */
  async findAliasById(id: Id<'partnerAlias'>): Promise<PartnerAliasRow | undefined> {
    const [row] = await this.db.select().from(partnerAliases).where(eq(partnerAliases.id, id));
    return row;
  }

  /**
   * Партнёры, из которых клиенту есть что выбирать, — под псевдонимами.
   *
   * Только подтверждённые: показывать клиенту партнёра, который не может принять вызов,
   * значит предложить построить порядок вокруг пустого места.
   *
   * Ни идентификатора партнёра, ни настоящего имени в результате нет и быть не может
   * (ADR-0014): это единственное, что клиент о партнёре узнаёт.
   */
  /**
   * `exceptOwner` убирает партнёра, которым владеет спрашивающий клиент: звонить
   * через себя ему нельзя (ADR-0052), и свой псевдоним в списке был бы пустым выбором.
   */
  async listOfferedAliases(
    exceptOwner?: Id<'user'>,
  ): Promise<(PartnerAliasRow & { listensToRecordings: boolean })[]> {
    return this.db
      .select({
        id: partnerAliases.id,
        partnerId: partnerAliases.partnerId,
        displayName: partnerAliases.displayName,
        createdAt: partnerAliases.createdAt,
        // Объявленное партнёром намерение слушать записи своих вызовов
        // ([ADR-0036](../../../../../docs/adr/0036-dostup-partnyora-k-zapisyam.md)).
        // Это свойство псевдонима, а не личность: клиент решает, работать ли с таким.
        listensToRecordings: partners.listensToRecordings,
      })
      .from(partnerAliases)
      .innerJoin(partners, eq(partners.id, partnerAliases.partnerId))
      .where(
        and(
          eq(partners.status, 'verified'),
          exceptOwner === undefined ? undefined : ne(partners.ownerUserId, exceptOwner),
        ),
      )
      .orderBy(orderByText(partnerAliases.displayName));
  }

  /** Меняет объявленное намерение партнёра слушать записи. */
  async setListensToRecordings(id: PartnerId, listens: boolean): Promise<PartnerRow | undefined> {
    const [row] = await this.db
      .update(partners)
      .set({ listensToRecordings: listens, updatedAt: new Date() })
      .where(eq(partners.id, id))
      .returning();
    return row;
  }

  /** Псевдонимы перечисленных партнёров — одним запросом, а не по одному на партнёра. */
  async listAliasesByPartners(ids: readonly PartnerId[]): Promise<PartnerAliasRow[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(partnerAliases)
      .where(inArray(partnerAliases.partnerId, [...ids]));
  }

  /**
   * Клиент, которым владеет этот пользователь.
   *
   * Живёт здесь, а не в модуле, которому понадобилось: `clients` — таблица биллинга,
   * и читать её напрямую из чужого модуля значит завести вторую версию правила
   * «чей это клиент» (ARCHITECTURE.md, границы модулей).
   */
  async findClientOwnedBy(
    userId: Id<'user'>,
    executor: Executor = this.db,
  ): Promise<{ id: ClientId } | undefined> {
    const [row] = await executor
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.ownerUserId, userId));
    return row;
  }

  /**
   * Партнёр, которым владеет этот пользователь.
   *
   * Роль — первый рубеж, владение проверяет служба ([ADR-0018](../../../../../docs/adr/0018-autentifikaciya.md)):
   * роль `partner` говорит лишь о том, что человек партнёр, а не о том, **какой**.
   */
  async findPartnerOwnedBy(
    userId: Id<'user'>,
    executor: Executor = this.db,
  ): Promise<{ id: PartnerId } | undefined> {
    const [row] = await executor
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.ownerUserId, userId));
    return row;
  }

  /**
   * Карточки, которыми владеют перечисленные учётные записи, — одним обращением на список.
   * Нужен списку учётных записей: «участник» без слов «клиент» и «партнёр» не говорит ничего.
   */
  async listCabinetsOwnedBy(userIds: readonly Id<'user'>[]): Promise<{
    clients: { ownerUserId: Id<'user'>; id: ClientId; name: string; status: ClientStatus }[];
    partners: { ownerUserId: Id<'user'>; id: PartnerId; name: string; status: PartnerStatus }[];
  }> {
    if (userIds.length === 0) return { clients: [], partners: [] };
    const [clientRows, partnerRows] = await Promise.all([
      this.db
        .select({
          ownerUserId: clients.ownerUserId,
          id: clients.id,
          name: clients.name,
          status: clients.status,
        })
        .from(clients)
        .where(inArray(clients.ownerUserId, [...userIds])),
      this.db
        .select({
          ownerUserId: partners.ownerUserId,
          id: partners.id,
          name: partners.name,
          status: partners.status,
        })
        .from(partners)
        .where(inArray(partners.ownerUserId, [...userIds])),
    ]);
    return { clients: clientRows, partners: partnerRows };
  }

  /**
   * Работающие клиенты с владельцем — для рассылки по условию. Страницами по `id`, не больше
   * `limit`: проход идёт порциями и не читает всю таблицу.
   */
  async listActiveClientOwners(
    after: ClientId | undefined,
    limit: number,
  ): Promise<{ id: ClientId; name: string; ownerUserId: Id<'user'> }[]> {
    return this.db
      .select({ id: clients.id, name: clients.name, ownerUserId: clients.ownerUserId })
      .from(clients)
      .where(
        after === undefined
          ? eq(clients.status, 'active')
          : and(eq(clients.status, 'active'), sql`${clients.id} > ${after}`),
      )
      .orderBy(asc(clients.id))
      .limit(limit);
  }

  /**
   * Деньги каждого вызова по его проводке `charge:<вызов>`: сколько списано с клиента (в знаке
   * «потрачено», положительно), сколько начислено партнёру и сколько осталось площадке. Вызова
   * без проводки — отказ, ноль секунд — в ответе нет. Какую часть показать, решает вызывающий:
   * клиенту — свою, партнёру — свою, сотруднику — все (ADR-0014).
   */
  async chargesForCalls(callIds: readonly string[]): Promise<Map<string, CallCharges>> {
    if (callIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        key: ledgerTransactions.idempotencyKey,
        client: sql<string>`-coalesce(sum(${ledgerEntries.amount}) filter (where ${accounts.kind} = 'client'), 0)`,
        partner: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${accounts.kind} = 'partner'), 0)`,
        revenue: sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${accounts.kind} = 'revenue'), 0)`,
      })
      .from(ledgerTransactions)
      .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id))
      .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
      .where(
        inArray(
          ledgerTransactions.idempotencyKey,
          callIds.map((id) => `charge:${id}`),
        ),
      )
      .groupBy(ledgerTransactions.idempotencyKey);
    return new Map(
      rows.map((row) => [
        row.key.slice('charge:'.length),
        {
          client: BigInt(row.client) as MoneyAmount,
          partner: BigInt(row.partner) as MoneyAmount,
          revenue: BigInt(row.revenue) as MoneyAmount,
        },
      ]),
    );
  }

  async findPartnerAlias(partnerId: PartnerId): Promise<string | undefined> {
    const [row] = await this.db
      .select({ displayName: partnerAliases.displayName })
      .from(partnerAliases)
      .where(eq(partnerAliases.partnerId, partnerId));
    return row?.displayName;
  }

  /**
   * Чей это псевдоним.
   *
   * Нужно ради внятного отказа при переименовании: уникальный индекс отвечает
   * «такая запись уже существует», а человеку надо знать, что имя занято.
   */
  /**
   * Названия клиентов пачкой.
   *
   * Одним запросом на страницу, а не по строке: страница в двести вызовов дала бы
   * двести запросов там, где хватает одного.
   */
  async clientNamesOf(ids: readonly ClientId[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(inArray(clients.id, [...ids]));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /**
   * Имена партнёров пачкой — вместе с псевдонимом.
   *
   * Настоящее имя отдаётся только административному контуру
   * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)); за тем,
   * куда оно уйдёт, следит вызывающий обработчик.
   */
  async partnerNamesOf(
    ids: readonly PartnerId[],
  ): Promise<Map<string, { name: string; displayName: string | null }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        id: partners.id,
        name: partners.name,
        displayName: partnerAliases.displayName,
      })
      .from(partners)
      .leftJoin(partnerAliases, eq(partnerAliases.partnerId, partners.id))
      .where(inArray(partners.id, [...ids]));
    return new Map(rows.map((row) => [row.id, { name: row.name, displayName: row.displayName }]));
  }

  async findPartnerByAlias(displayName: string): Promise<PartnerId | undefined> {
    const [row] = await this.db
      .select({ partnerId: partnerAliases.partnerId })
      .from(partnerAliases)
      .where(eq(partnerAliases.displayName, displayName));
    return row?.partnerId;
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
    executor: Executor = this.db,
  ): Promise<AccountRow> {
    const existing = await this.findAccount(kind, ownerId, currency, executor);
    if (existing !== undefined) return existing;

    try {
      const [created] = await executor
        .insert(accounts)
        .values({ id: newId<'account'>(), kind, ownerId, currency })
        .onConflictDoNothing()
        .returning();
      if (created !== undefined) return created;
    } catch (cause) {
      throw toDatabaseError(cause);
    }

    const after = await this.findAccount(kind, ownerId, currency, executor);
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

  /**
   * Проводки счёта вместе с тем, **что произошло**.
   *
   * Одна сумма без вида и описания — это столбец чисел, по которому нельзя ответить
   * ни на один вопрос разбора. Вид и описание живут в операции, а не в проводке:
   * вопрос «что это было» задают к операции, а не к её половине.
   */
  async listEntries(
    accountId: AccountId,
    limit: number,
    offset: number,
  ): Promise<{ rows: LedgerEntryWithTransaction[]; total: number }> {
    const rows = await this.db
      .select({
        seq: ledgerEntries.seq,
        transactionId: ledgerEntries.transactionId,
        amount: ledgerEntries.amount,
        createdAt: ledgerEntries.createdAt,
        kind: ledgerTransactions.kind,
        description: ledgerTransactions.description,
        referenceType: ledgerTransactions.referenceType,
        referenceId: ledgerTransactions.referenceId,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
      .where(eq(ledgerEntries.accountId, accountId))
      .orderBy(desc(ledgerEntries.seq))
      .limit(limit)
      .offset(offset);

    const [counted] = await this.db
      .select({ total: count() })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, accountId));

    return { rows, total: counted?.total ?? 0 };
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
