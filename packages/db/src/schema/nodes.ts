/**
 * Узлы АТС (ADR-0009).
 *
 * Запись заводит администратор **до** установки: по ARCHITECTURE.md он создаёт узел
 * в панели, а система выдаёт команду установки. Отсюда и первое состояние жизненного
 * цикла — `provisioned`: узел существует как запись и ещё не отвечает.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { NODE_STATUSES, type NodeStatus } from '@zvonix/shared';
import { createdAt, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';

export const nodes = pgTable(
  'nodes',
  {
    id: primaryId<'node'>(),

    /** Человекочитаемое имя: «Москва-1». По нему узел ищут в панели и называют в разговоре. */
    name: text().notNull(),

    /**
     * Имя, которым узел представляется в запросах (`hostname` от `mod_xml_curl`).
     *
     * Сверяется с ключом при каждом обращении: расхождение означает, что ключ применён
     * не на том узле, для которого выпущен. Заполняется при регистрации — до установки
     * настоящее имя машины неизвестно.
     */
    hostname: text(),

    /**
     * Адрес, на который партнёры направляют свои GOIP. Публичный: попадает в инструкцию
     * партнёру, поэтому это не тот адрес, с которого узел сам обращается к control plane.
     */
    sipAddress: text(),

    status: text().$type<NodeStatus>().notNull().default('provisioned'),

    /** Версия агента. Расхождение версий между узлами — первое, что смотрят при разборе. */
    agentVersion: text(),

    /**
     * Последний heartbeat. Молчание дольше порога переводит узел в `offline`,
     * и вызовы на него не направляются.
     */
    lastHeartbeatAt: timestamptz(),

    /** Активных вызовов на момент последнего heartbeat. */
    activeCalls: integer().notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('nodes_status_check', oneOf(t.status, NODE_STATUSES)),
    check('nodes_active_calls_non_negative', sql`${t.activeCalls} >= 0`),
    uniqueIndex('nodes_name_key').on(t.name),
    // Имя машины уникально среди заполненных: два узла с одним `hostname` означают,
    // что запрос маршрута нельзя достоверно отнести к узлу. NULL до установки —
    // штатное состояние, поэтому индекс частичный.
    uniqueIndex('nodes_hostname_key')
      .on(t.hostname)
      .where(sql`${t.hostname} is not null`),
    index('nodes_status_idx').on(t.status),
  ],
);
