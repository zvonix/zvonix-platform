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
  DEFAULT_MAX_CONCURRENT_CALLS,
  GATEWAY_PORT_STATES,
  GATEWAY_STATUSES,
  GATEWAY_TYPES,
  MAX_CONCURRENT_CALLS_LIMIT,
  SIM_NETWORK_SCOPES,
  SIM_STATUSES,
  type ChannelStatus,
  type GatewayPortState,
  type GatewayStatus,
  type GatewayType,
  type SimNetworkScope,
  type SimStatus,
} from '@zvonix/shared';
import { createdAt, idRef, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { clients, partners } from './billing.js';
import { operators } from './catalog.js';
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

/**
 * SIM-карта партнёра.
 *
 * Номер SIM — персональные данные партнёра и **в клиентский контур не попадает никогда**
 * ([ADR-0014](../../docs/adr/0014-vybor-partnera-klientom.md)): по нему клиент вышел бы
 * на партнёра напрямую в обход платформы.
 */
export const simCards = pgTable(
  'sim_cards',
  {
    id: primaryId<'simCard'>(),
    partnerId: idRef<'partner'>()
      .notNull()
      .references(() => partners.id, { onDelete: 'restrict' }),

    /**
     * Оператор, которого объявил партнёр.
     *
     * От него зависит вся экономика вызова: SIM звонит бесплатно только внутри своей
     * сети. Ошибка здесь означает, что каждый вызов через эту SIM платный для партнёра,
     * поэтому объявленное значение сверяется с ответом `OperatorResolver` по её же номеру.
     */
    operatorId: idRef<'operator'>()
      .notNull()
      .references(() => operators.id, { onDelete: 'restrict' }),

    /** Собственный номер SIM в нормализованном виде: 11 цифр, начиная с 7. */
    msisdn: text().notNull(),

    /** Идентификатор чипа. Переживает смену номера и перестановку между шлюзами. */
    iccid: text(),

    status: text().$type<SimStatus>().notNull().default('new'),

    /** Куда SIM может звонить по тарифу. В v1 значение одно — только своя сеть. */
    networkScope: text().$type<SimNetworkScope>().notNull().default('own_network'),

    /**
     * Сколько вызовов SIM обслуживает одновременно. Меняет **только администратор**:
     * превышение — прямой путь к блокировке SIM оператором.
     */
    maxConcurrentCalls: integer().notNull().default(DEFAULT_MAX_CONCURRENT_CALLS),

    /**
     * Когда объявленный оператор совпал с подтверждённым ответом резолвера.
     * Пусто — сверка не удалась: оператор не подтверждён источником, а не опровергнут.
     */
    operatorConfirmedAt: timestamptz(),

    /** Дата активации у оператора. По ней считается возраст SIM в антифроде. */
    activatedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('sim_cards_status_check', oneOf(t.status, SIM_STATUSES)),
    check('sim_cards_network_scope_check', oneOf(t.networkScope, SIM_NETWORK_SCOPES)),
    check('sim_cards_msisdn_format', sql`${t.msisdn} ~ '^7[0-9]{10}$'`),
    check(
      'sim_cards_max_concurrent_calls_range',
      sql`${t.maxConcurrentCalls} between 1 and ${sql.raw(String(MAX_CONCURRENT_CALLS_LIMIT))}`,
    ),
    // Один номер не может быть двумя SIM: иначе вызовы разъедутся по двум записям,
    // а лимиты и счётчики перестанут что-либо ограничивать.
    uniqueIndex('sim_cards_msisdn_key').on(t.msisdn),
    uniqueIndex('sim_cards_iccid_key')
      .on(t.iccid)
      .where(sql`${t.iccid} is not null`),
    index('sim_cards_partner_idx').on(t.partnerId),
    // Горячий путь маршрутизации: свободная SIM нужного оператора.
    index('sim_cards_operator_status_idx').on(t.operatorId, t.status),
  ],
);

/**
 * Физический порт шлюза с установленной SIM.
 *
 * Не канал: канал — линия клиента, порт — слот с SIM у партнёра. Смешивать нельзя,
 * см. GLOSSARY.md.
 */
export const gatewayPorts = pgTable(
  'gateway_ports',
  {
    id: primaryId<'gatewayPort'>(),
    gatewayId: idRef<'gateway'>()
      .notNull()
      .references(() => gateways.id, { onDelete: 'cascade' }),

    /** Номер порта на устройстве, как он подписан на корпусе. */
    portNumber: integer().notNull(),

    /**
     * Установленная сейчас SIM. Обнуляется при извлечении: **SIM переживает порт**
     * и может переехать в другой шлюз, сохранив свою историю и счётчики.
     */
    simCardId: idRef<'simCard'>().references(() => simCards.id, { onDelete: 'set null' }),

    state: text().$type<GatewayPortState>().notNull().default('unknown'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('gateway_ports_state_check', oneOf(t.state, GATEWAY_PORT_STATES)),
    check('gateway_ports_number_positive', sql`${t.portNumber} >= 1`),
    uniqueIndex('gateway_ports_slot_key').on(t.gatewayId, t.portNumber),
    // Одна SIM стоит ровно в одном порту. Без этого она оказалась бы «свободна»
    // в двух местах сразу, и одновременных вызовов на ней стало бы вдвое больше.
    uniqueIndex('gateway_ports_sim_key')
      .on(t.simCardId)
      .where(sql`${t.simCardId} is not null`),
    index('gateway_ports_gateway_idx').on(t.gatewayId),
  ],
);

/**
 * Приоритет партнёра в канале клиента (ADR-0014).
 *
 * Клиент видит партнёров только под псевдонимами и сам расставляет им порядок.
 * Маршрутизация идёт по приоритетам сверху вниз, а **не по цене**: выбор клиента главнее,
 * а цена влияет на то, сколько он заплатит, но не на порядок перебора.
 *
 * **Отсутствие строк у канала означает «все партнёры».** Иначе новый канал не смог бы
 * позвонить, пока кто-то не заполнит список, и это выглядело бы поломкой, а не настройкой.
 * Как только появилась хоть одна строка, список становится закрытым: партнёр, которого
 * в нём нет, не используется — так выражается «этого партнёра я не хочу».
 */
export const channelPartnerPriorities = pgTable(
  'channel_partner_priorities',
  {
    id: primaryId<'channelPartnerPriority'>(),

    channelId: idRef<'channel'>()
      .notNull()
      // Приоритеты удалённого канала не значат ничего и никому не нужны.
      .references(() => channels.id, { onDelete: 'cascade' }),

    partnerId: idRef<'partner'>()
      .notNull()
      .references(() => partners.id, { onDelete: 'restrict' }),

    /** Меньше — раньше. Единица — первый, к кому пойдёт вызов. */
    priority: integer().notNull(),

    /**
     * Когда партнёру в последний раз выдавали маршрут по этому каналу.
     *
     * Равные приоритеты чередуются по давности: первым идёт тот, кто дольше всех
     * не получал трафика (ADR-0021).
     * Пусто — ещё ни разу, и такой партнёр идёт впереди всех.
     */
    lastRoutedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('channel_partner_priorities_priority_positive', sql`${t.priority} > 0`),
    // Один партнёр в канале ровно с одним приоритетом: два означали бы, что порядок
    // перебора зависит от того, какую строку прочитали первой.
    uniqueIndex('channel_partner_priorities_channel_partner_key').on(t.channelId, t.partnerId),
    // Горячий путь: отбор кандидатов сразу в нужном порядке.
    index('channel_partner_priorities_order_idx').on(t.channelId, t.priority, t.lastRoutedAt),
  ],
);
