/**
 * Ключи машинного доступа (ADR-0019).
 *
 * Одна таблица на узлы, клиентские ключи и одноразовые токены установки: состав полей
 * у них совпадает, различается только субъект. Заводить три похожие таблицы значит
 * трижды писать проверку срока, отзыва и списка адресов — и однажды написать её по-разному.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { MACHINE_KEY_KINDS, type MachineKeyKind } from '@zvonix/shared';
import { createdAt, idRef, oneOf, primaryId, timestamptz } from '../columns.js';
import { users } from './users.js';

export const machineCredentials = pgTable(
  'machine_credentials',
  {
    id: primaryId<'machineCredential'>(),
    kind: text().$type<MachineKeyKind>().notNull(),

    /**
     * Публичная часть: `zvx_node_a1b2c3d4e5f6`. Ищется по индексу и безопасно печатается
     * в логах — по ней разбирают инцидент, не раскрывая секрета.
     */
    keyId: text().notNull(),

    /**
     * SHA-256 от секрета. Не argon2: проверка выполняется **на каждый звонок**, а перебирать
     * 256 бит случайности всё равно нечего (ADR-0019).
     */
    secretHash: text().notNull(),

    /**
     * Узел или клиент. Ссылки на две разные таблицы внешним ключом не выразить —
     * как `accounts.owner_id` в ADR-0010.
     *
     * Обязателен и у токена установки: по ARCHITECTURE.md администратор сначала заводит
     * узел, а уже потом получает команду установки для него. Ничей токен позволял бы
     * зарегистрировать узел, которого никто не заводил.
     */
    ownerId: text().notNull(),

    /** Человекочитаемое назначение: «Узел Москва-1, ключ от 2026-09-01». */
    label: text().notNull(),

    /**
     * Адреса, с которых ключ принимается. Пусто — откуда угодно.
     *
     * Единственная мера, работающая и против кражи ключа с самого узла: украденный ключ
     * вне узла бесполезен. Поэтому у ключей узлов список положено заполнять.
     */
    allowedIps: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /** У узлов пусто: истёкший ключ узла означает отказ телефонии (ADR-0019). */
    expiresAt: timestamptz(),

    /** Обновляется не чаще раза в пять минут — иначе каждый звонок пишет в базу. */
    lastUsedAt: timestamptz(),

    /** Отзыв пометкой, а не удалением: иначе в журнале дыра там, где нужно разбираться. */
    revokedAt: timestamptz(),

    /** Только у `enrollment`: отметка о единственном применении. */
    usedAt: timestamptz(),

    createdByUserId: idRef<'user'>().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    check('machine_credentials_kind_check', oneOf(t.kind, MACHINE_KEY_KINDS)),
    // Отметка о применении имеет смысл только у одноразового токена. У постоянного ключа
    // она означала бы, что кто-то перепутал её с `last_used_at`, и ключ тихо стал разовым.
    check(
      'machine_credentials_used_at_only_enrollment',
      sql`${t.usedAt} is null or ${t.kind} = 'enrollment'`,
    ),
    uniqueIndex('machine_credentials_key_id_key').on(t.keyId),
    // Горячий путь: поиск действующих ключей владельца при ротации и в панели.
    index('machine_credentials_owner_idx').on(t.kind, t.ownerId),
  ],
);
