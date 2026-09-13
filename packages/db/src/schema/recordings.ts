/**
 * Записи разговоров (ADR-0012, ARCHITECTURE.md).
 *
 * В базе только ссылка на объект и его свойства — сам файл лежит в объектном хранилище.
 * Объём записей растёт линейно и бесконечно, и в базе им не место.
 *
 * **Запись — персональные данные абонента.** Отсюда всё остальное: срок хранения задаётся
 * явно, доступ только по подписанной ссылке, каждое обращение попадает в журнал аудита.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, idRef, primaryId, timestamptz } from '../columns.js';
import { partners } from './billing.js';
import { calls } from './calls.js';
import { users } from './users.js';

export const recordings = pgTable(
  'recordings',
  {
    id: primaryId<'recording'>(),

    /**
     * Вызов, которому принадлежит запись.
     *
     * Ровно один: инвариант DOMAIN.md. Удаление вызова запрещено — CDR не удаляются
     * никогда, а запись уходит по своему сроку хранения.
     */
    callId: idRef<'call'>()
      .notNull()
      .references(() => calls.id, { onDelete: 'restrict' }),

    /**
     * Ключ объекта в хранилище: `recordings/2026/09/<вызов>.wav`.
     *
     * Задаёт **control plane**, а не узел. Иначе скомпрометированный узел мог бы
     * прислать ключ чужой записи и затереть её.
     */
    objectKey: text().notNull(),

    /** Длительность в секундах. Может отличаться от длительности вызова на доли секунды. */
    durationSeconds: integer(),

    /** Размер объекта в байтах — по нему видно, что выгрузился не пустой файл. */
    sizeBytes: bigint({ mode: 'bigint' }),

    /**
     * Момент подтверждённой выгрузки. Пусто — ссылка на выгрузку выдана,
     * но узел ещё не отчитался: файл мог не доехать.
     */
    uploadedAt: timestamptz(),

    /**
     * Когда запись подлежит удалению вместе с объектом.
     *
     * Считается при выдаче ссылки на выгрузку, а не при удалении: срок хранения,
     * зависящий от момента уборки, — это отсутствие срока.
     */
    expiresAt: timestamptz().notNull(),

    /** Момент удаления объекта. Строка остаётся: по ней видно, что запись была и ушла. */
    deletedAt: timestamptz(),

    createdAt: createdAt(),
  },
  (t) => [
    check(
      'recordings_duration_non_negative',
      sql`${t.durationSeconds} is null or ${t.durationSeconds} >= 0`,
    ),
    check('recordings_size_positive', sql`${t.sizeBytes} is null or ${t.sizeBytes} > 0`),
    // Один вызов — одна запись (инвариант DOMAIN.md). Вторая означала бы, что одна
    // из них потеряется: по вызову ищут запись, а не записи.
    uniqueIndex('recordings_call_key').on(t.callId),
    uniqueIndex('recordings_object_key').on(t.objectKey),
    // Отбор просроченных фоновой уборкой.
    index('recordings_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * Разовый доступ партнёра к одной записи
 * ([ADR-0036](../../../docs/adr/0036-dostup-partnyora-k-zapisyam.md)).
 *
 * Нужен для разбора спора: «моя SIM исправна, дело не в ней». Существует независимо
 * от объявленного намерения партнёра и работает, даже когда оно выключено, — это
 * и есть параллельный путь.
 *
 * Три свойства, без которых доступ превращается в постоянный: привязан к **записи**,
 * а не к партнёру и не к периоду; **истекает**; и каждое обращение по нему попадает
 * в журнал действий, как и всякая выдача записи.
 */
export const recordingGrants = pgTable(
  'recording_grants',
  {
    id: primaryId<'recordingGrant'>(),

    recordingId: idRef<'recording'>()
      .notNull()
      // Запись не удаляется, пока на неё есть выданный доступ: иначе разбор спора
      // теряет и запись, и след того, кому её открывали.
      .references(() => recordings.id, { onDelete: 'restrict' }),

    /**
     * Кому открыт доступ.
     *
     * Проверяется при выдаче: партнёр обязан быть тем, чья SIM обслужила вызов, —
     * иначе это выдача чужих разговоров.
     */
    partnerId: idRef<'partner'>()
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),

    /** Кто открыл. Пусто после удаления учётной записи — сам факт выдачи остаётся. */
    grantedByUserId: idRef<'user'>().references(() => users.id, { onDelete: 'set null' }),

    /** Зачем открыт: номер обращения, суть спора. Обязательна — доступ без причины не выдаётся. */
    reason: text().notNull(),

    /** До какого момента действует. Истёкший доступ не удаляется: он часть следа. */
    expiresAt: timestamptz().notNull(),

    /** Отозван раньше срока. Строка остаётся: по ней видно, что доступ был. */
    revokedAt: timestamptz(),

    createdAt: createdAt(),
  },
  (t) => [
    check('recording_grants_reason_not_empty', sql`length(btrim(${t.reason})) > 0`),
    // Горячий путь проверки права: действующий доступ этого партнёра к этой записи.
    index('recording_grants_lookup_idx').on(t.recordingId, t.partnerId, t.expiresAt),
    index('recording_grants_partner_idx').on(t.partnerId),
  ],
);
