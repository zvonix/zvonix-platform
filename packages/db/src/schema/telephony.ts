/**
 * Учётные записи SIP: шлюзы партнёров и каналы клиентов (ADR-0009).
 *
 * Обе стороны вызова опознаются узлом по регистрации SIP, и обе получают учётные данные
 * из control plane, а не из файла на узле. Смысл в том, чтобы **на узле не осталось
 * ни одного пароля**: заблокировали партнёра — его шлюз перестал регистрироваться
 * при следующей же попытке, без раскатки конфигурации.
 *
 * Пароль здесь не хранится ни в каком виде. Хранится `a1_hash` — то, что SIP использует
 * для digest-проверки: `MD5(имя:realm:пароль)`. Сам пароль показывается один раз
 * при выдаче и больше не восстанавливается.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  CHANNEL_STATUSES,
  GATEWAY_STATUSES,
  GATEWAY_TYPES,
  type ChannelStatus,
  type GatewayStatus,
  type GatewayType,
} from '@zvonix/shared';
import { createdAt, idRef, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { clients, partners } from './billing.js';
import { nodes } from './nodes.js';

/** Шлюз партнёра: GOIP или телефон на Android. */
export const gateways = pgTable(
  'gateways',
  {
    id: primaryId<'gateway'>(),
    partnerId: idRef<'partner'>()
      .notNull()
      .references(() => partners.id, { onDelete: 'restrict' }),

    /** Имя для партнёра: «GOIP в гараже». В клиентский контур не попадает (ADR-0014). */
    name: text().notNull(),
    type: text().$type<GatewayType>().notNull(),
    status: text().$type<GatewayStatus>().notNull().default('pending'),

    /**
     * Имя учётной записи SIP: `gw-a1b2c3d4e5f6`. Уникально по всей платформе, потому что
     * realm один на всю платформу и шлюз может зарегистрироваться на любом узле.
     */
    sipUsername: text().notNull(),

    /**
     * `MD5(имя:realm:пароль)` — то, чем SIP проверяет digest. Пароля в базе нет.
     *
     * Это не «безопасный хеш»: обладание им равносильно знанию пароля для входа по SIP.
     * Но пароль не наш, а придуманный при выдаче, и утечка таблицы не даёт его в открытом
     * виде — то есть не даёт подобрать по нему другие учётные записи партнёра.
     */
    a1Hash: text().notNull(),

    /**
     * Узел, на котором шлюз зарегистрирован сейчас. Пусто, пока не регистрировался.
     * Обнуляется при выводе узла: шлюз перерегистрируется на другой.
     */
    nodeId: idRef<'node'>().references(() => nodes.id, { onDelete: 'set null' }),

    /** Момент последней успешной регистрации. По нему видно, живой ли шлюз. */
    registeredAt: timestamptz(),

    /** Модель оборудования и число портов — для разбора и подсказок партнёру. */
    model: text(),
    portCount: integer().notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('gateways_type_check', oneOf(t.type, GATEWAY_TYPES)),
    check('gateways_status_check', oneOf(t.status, GATEWAY_STATUSES)),
    check('gateways_port_count_non_negative', sql`${t.portCount} >= 0`),
    uniqueIndex('gateways_sip_username_key').on(t.sipUsername),
    index('gateways_partner_idx').on(t.partnerId),
    index('gateways_node_idx').on(t.nodeId),
    index('gateways_status_idx').on(t.status),
  ],
);

/**
 * Канал клиента — линия исходящей связи с её правилами.
 *
 * Не порт шлюза: канал принадлежит клиенту и описывает, как ему разрешено звонить.
 * Смешивать эти два понятия нельзя, см. GLOSSARY.md.
 */
export const channels = pgTable(
  'channels',
  {
    id: primaryId<'channel'>(),
    clientId: idRef<'client'>()
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),

    name: text().notNull(),
    status: text().$type<ChannelStatus>().notNull().default('pending'),

    /** Имя учётной записи SIP: `ch-a1b2c3d4e5f6`. */
    sipUsername: text().notNull(),
    a1Hash: text().notNull(),

    /**
     * Требуется ли запись разговора.
     *
     * Канал с этим признаком **никогда** не маршрутизируется на шлюз типа `android`:
     * там запись технически невозможна ([ADR-0012](../../docs/adr/0012-mobilnoe-prilozhenie.md)).
     */
    recordingRequired: boolean().notNull().default(false),

    /** Номер, который увидит вызываемый. Пусто — номер SIM, с которой ушёл вызов. */
    callerId: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('channels_status_check', oneOf(t.status, CHANNEL_STATUSES)),
    uniqueIndex('channels_sip_username_key').on(t.sipUsername),
    index('channels_client_idx').on(t.clientId),
    index('channels_status_idx').on(t.status),
  ],
);
