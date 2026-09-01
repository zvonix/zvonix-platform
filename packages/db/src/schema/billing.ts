/**
 * Клиенты, партнёры, счета и журнал проводок (ADR-0010).
 *
 * Баланс здесь не поле, которое кто-то правит, а **следствие проводок**. Материализованный
 * остаток на счёте существует ради скорости и сверяется фоновой задачей; источник истины —
 * `ledger_entries`. Прямая правка остатка — не оптимизация, а потеря истории, после которой
 * спор с клиентом или партнёром разрешить нечем.
 */

import { sql } from 'drizzle-orm';
import { bigserial, check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  ACCOUNT_KINDS,
  CLIENT_STATUSES,
  PARTNER_STATUSES,
  TRANSACTION_KINDS,
  type AccountKind,
  type ClientStatus,
  type PartnerStatus,
  type TransactionKind,
} from '@zvonix/shared';
import { createdAt, idRef, money, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { users } from './users.js';

/** Служба такси. Звонит и платит. */
export const clients = pgTable(
  'clients',
  {
    id: primaryId<'client'>(),

    /** Учётная запись владельца. Сотрудников с доступом может быть несколько — это первый. */
    ownerUserId: idRef<'user'>()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    name: text().notNull(),
    status: text().$type<ClientStatus>().notNull().default('pending'),

    /**
     * Насколько глубоко клиенту разрешено уходить в минус, в микроединицах.
     *
     * Ноль означает «только на свои». Величина положительная, а сравнение идёт
     * с отрицательным остатком: хранить предел со знаком минус — верный способ
     * однажды перепутать направление и раздать бесконечный кредит.
     */
    overdraftLimit: money()
      .notNull()
      .default(sql`0`),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('clients_status_check', oneOf(t.status, CLIENT_STATUSES)),
    check('clients_overdraft_non_negative', sql`${t.overdraftLimit} >= 0`),
    index('clients_owner_idx').on(t.ownerUserId),
    index('clients_status_idx').on(t.status),
  ],
);

/** Физлицо с SIM и шлюзом. Терминирует вызовы и получает выплаты. */
export const partners = pgTable(
  'partners',
  {
    id: primaryId<'partner'>(),
    ownerUserId: idRef<'user'>()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /** Настоящее имя. В клиентский контур не попадает ни при каких условиях (ADR-0014). */
    name: text().notNull(),
    status: text().$type<PartnerStatus>().notNull().default('pending'),

    /**
     * Реквизиты для выплат. Персональные данные: наружу не отдаются, в логах не появляются.
     * Состав зависит от способа выплат и потому хранится структурой, а не колонками.
     */
    payoutDetails: jsonb(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('partners_status_check', oneOf(t.status, PARTNER_STATUSES)),
    index('partners_owner_idx').on(t.ownerUserId),
    index('partners_status_idx').on(t.status),
  ],
);

/**
 * Псевдоним партнёра, видимый клиенту (ADR-0014).
 *
 * Единственное, что клиент вообще знает о партнёре. Имя, контакты, реквизиты, номера SIM
 * и адреса шлюзов в клиентский контур не попадают ни в API, ни в отчётах, ни в CDR:
 * обход платформы напрямую означает потерю выручки.
 */
export const partnerAliases = pgTable(
  'partner_aliases',
  {
    id: primaryId<'partnerAlias'>(),
    partnerId: idRef<'partner'>()
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),

    /** Отображаемое имя вида «Партнёр 17». Не должно намекать на личность. */
    displayName: text().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('partner_aliases_display_name_key').on(t.displayName),
    // Один партнёр — один псевдоним: несколько превратили бы одного поставщика
    // в нескольких разных в глазах клиента, и распределение трафика поехало бы.
    uniqueIndex('partner_aliases_partner_key').on(t.partnerId),
  ],
);

/**
 * Счёт.
 *
 * Кроме счетов клиентов и партнёров есть системные — без них у проводки не было бы
 * второй стороны и двойная запись не сходилась бы.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: primaryId<'account'>(),
    kind: text().$type<AccountKind>().notNull(),

    /**
     * Владелец: клиент или партнёр. У системных счетов пусто — они не принадлежат никому.
     * Ссылки на две разные таблицы внешним ключом не выразить, поэтому целостность
     * держится на том, что счета заводит только модуль биллинга.
     */
    ownerId: text(),

    /** Валюта счёта. В v1 одна, но проводки между валютами не сойдутся, поэтому поле есть. */
    currency: text().notNull().default('RUB'),

    /**
     * Материализованный остаток в микроединицах.
     *
     * Существует ради скорости: считать сумму всех проводок на каждый вызов нельзя.
     * Источник истины — `ledger_entries`, и расхождение находит ежедневная сверка.
     * Правится только модулем биллинга и только вместе со вставкой проводок.
     */
    balance: money()
      .notNull()
      .default(sql`0`),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('accounts_kind_check', oneOf(t.kind, ACCOUNT_KINDS)),
    // Системный счёт — один на вид и без владельца; счёт участника — ровно наоборот.
    check(
      'accounts_owner_matches_kind',
      sql`(${t.kind} in ('client', 'partner') and ${t.ownerId} is not null) or (${t.kind} in ('revenue', 'payable', 'settlement') and ${t.ownerId} is null)`,
    ),
    // Два частичных индекса вместо одного общего. Причина: PostgreSQL считает NULL
    // различными, и обычный уникальный индекс по (вид, владелец, валюта) допустил бы
    // сколько угодно системных счетов одного вида — журнал молча разъехался бы
    // на два несходящихся набора проводок.
    uniqueIndex('accounts_owned_key')
      .on(t.kind, t.ownerId, t.currency)
      .where(sql`${t.ownerId} is not null`),
    uniqueIndex('accounts_system_key')
      .on(t.kind, t.currency)
      .where(sql`${t.ownerId} is null`),
    index('accounts_kind_idx').on(t.kind),
  ],
);

/**
 * Операция: набор проводок с нулевой суммой.
 *
 * Существует отдельно от проводок, потому что вопрос «что произошло» задают к операции,
 * а не к её половине. Здесь же ключ идемпотентности: узел может прислать один и тот же
 * CDR повторно, и это штатный режим, а не ошибка.
 */
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: primaryId<'ledgerTransaction'>(),
    kind: text().$type<TransactionKind>().notNull(),

    /**
     * Ключ идемпотентности: `charge:<идентификатор вызова>`, `deposit:<номер платежа>`.
     *
     * Уникальность обеспечивает база, а не проверка в коде: две одновременные попытки
     * провести один и тот же CDR иначе обе пройдут проверку и обе спишут деньги.
     */
    idempotencyKey: text().notNull(),

    /** На что ссылается операция: вызов, платёж, заявка на выплату. */
    referenceType: text(),
    referenceId: text(),

    /** Человекочитаемое пояснение. В споре читают именно его. */
    description: text().notNull(),

    /** Кто провёл. Пусто у операций, порождённых системой: тарификация, сверка. */
    createdByUserId: idRef<'user'>().references(() => users.id, { onDelete: 'set null' }),

    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('ledger_transactions_kind_check', oneOf(t.kind, TRANSACTION_KINDS)),
    uniqueIndex('ledger_transactions_idempotency_key').on(t.idempotencyKey),
    index('ledger_transactions_reference_idx').on(t.referenceType, t.referenceId),
    index('ledger_transactions_occurred_at_idx').on(t.occurredAt),
  ],
);

/**
 * Проводка — половина движения денег по одному счёту.
 *
 * **Неизменяема.** Ошибка исправляется обратной проводкой, а не правкой: журнал, который
 * можно поправить, перестаёт быть доказательством ровно тогда, когда нужен больше всего.
 * Ограничения на уровне базы этого не выражают, поэтому правило держится на том,
 * что `UPDATE` и `DELETE` по этой таблице нет нигде в коде.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: primaryId<'ledgerEntry'>(),

    /**
     * Монотонный номер для человекочитаемой сверки (см. «Идентификаторы» в DOMAIN.md).
     * UUIDv7 упорядочен по времени, но в разговоре с бухгалтерией на него не сошлёшься.
     */
    seq: bigserial({ mode: 'bigint' }).notNull(),

    transactionId: idRef<'ledgerTransaction'>()
      .notNull()
      // Операция без проводок — бессмыслица, но и удалять проводки нельзя:
      // запрет тут строже каскада намеренно.
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),

    accountId: idRef<'account'>()
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),

    /**
     * Сумма со знаком, в микроединицах. Плюс — приход на счёт, минус — расход.
     *
     * Знак вместо отдельного поля «дебет/кредит»: сумма проводок операции обязана быть
     * нулём, и с числами со знаком это одно сложение, а не разбор направлений.
     */
    amount: money().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    // Проводка на ноль ничего не значит и только засоряет журнал.
    check('ledger_entries_amount_not_zero', sql`${t.amount} <> 0`),
    uniqueIndex('ledger_entries_seq_key').on(t.seq),
    index('ledger_entries_account_idx').on(t.accountId, t.createdAt),
    index('ledger_entries_transaction_idx').on(t.transactionId),
  ],
);
