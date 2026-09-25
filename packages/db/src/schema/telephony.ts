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
  GATEWAY_REGISTRATION_MODES,
  GATEWAY_STATUSES,
  GATEWAY_SUSPENDED_BY,
  GATEWAY_TYPES,
  DEFAULT_TRUNK_CONCURRENT_CALLS,
  MAX_CONCURRENT_CALLS_LIMIT,
  MAX_TRUNK_CONCURRENT_CALLS,
  SIM_NETWORK_SCOPES,
  SIM_STATUSES,
  TERMINATION_KINDS,
  type ChannelStatus,
  type GatewayPortState,
  type GatewayRegistrationMode,
  type GatewayStatus,
  type GatewaySuspendedBy,
  type GatewayType,
  type SimNetworkScope,
  type SimStatus,
  type TerminationKind,
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
     * Кто выключил: задан ровно у `suspended`
     * ([ADR-0047](../../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md)). Партнёр снимает только
     * своё выключение — отключение администратором или порогом отказов не снимает.
     */
    suspendedBy: text().$type<GatewaySuspendedBy>(),

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
     *
     * **Пусто у SIP-транка**: к нему регистрируемся мы, а не он к нам, и проверять digest
     * нечего ([ADR-0039](../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
     * Его `sip_username` при этом заполнен и служит именем исходящего sofia-gateway
     * на узле — тем же именем, каким GOIP значится в каталоге.
     */
    a1Hash: text(),

    /**
     * Узел, на котором шлюз зарегистрирован сейчас. Пусто, пока не регистрировался.
     * Обнуляется при выводе узла: шлюз перерегистрируется на другой.
     */
    nodeId: idRef<'node'>().references(() => nodes.id, { onDelete: 'set null' }),

    /** Момент последней успешной регистрации. По нему видно, живой ли шлюз. */
    registeredAt: timestamptz(),

    /**
     * Способ подключения ([ADR-0054](../../../../docs/adr/0054-vhod-po-liniyam-goip.md)):
     * `gateway` — регистрируется учётная запись шлюза, линия GOIP выбирается префиксом;
     * `port` — у каждого порта свой вход, и учётная запись шлюза каталогом не отдаётся.
     *
     * Умолчание `gateway` — то, как настроены все шлюзы до появления поля.
     */
    registrationMode: text().$type<GatewayRegistrationMode>().notNull().default('gateway'),

    /** Модель оборудования и число портов — для разбора и подсказок партнёру. */
    model: text(),
    portCount: integer().notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('gateways_type_check', oneOf(t.type, GATEWAY_TYPES)),
    check('gateways_status_check', oneOf(t.status, GATEWAY_STATUSES)),
    check(
      'gateways_suspended_by_check',
      sql`${t.suspendedBy} is null or ${oneOf(t.suspendedBy, GATEWAY_SUSPENDED_BY)}`,
    ),
    // Отключение без источника — шлюз, про который не сказать, кто вправе его вернуть;
    // источник без отключения — поле, по которому разбор пошёл бы по ложному следу.
    check(
      'gateways_suspended_by_matches_status',
      sql`(${t.status} = 'suspended') = (${t.suspendedBy} is not null)`,
    ),
    // Пустой хеш допустим ровно у транка: у всех, кто регистрируется к нам, он обязателен,
    // и шлюз без него молча перестал бы проходить проверку digest.
    check('gateways_a1_hash_required', sql`${t.a1Hash} is not null or ${t.type} = 'sip_trunk'`),
    check('gateways_port_count_non_negative', sql`${t.portCount} >= 0`),
    check(
      'gateways_registration_mode_check',
      oneOf(t.registrationMode, GATEWAY_REGISTRATION_MODES),
    ),
    // Вход по линиям — только у GOIP: у телефона слот один, у транка регистрируемся мы.
    check(
      'gateways_port_registration_goip_only',
      sql`${t.registrationMode} = 'gateway' or ${t.type} = 'goip'`,
    ),
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
    /**
     * Номер **не уникален** ([ADR-0043](../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md),
     * «Ревизия: номер SIM не уникален»).
     *
     * Уникальность стояла здесь с доводом «иначе лимиты перестанут ограничивать».
     * Довод не выдержал проверки: лимиты защищают **физическую** карту, а она стоит
     * ровно в одном порту — две записи с одним номером не дают двух карт, они дают
     * одну карту и одну запись-призрак, которой не соответствует ничего.
     *
     * Зато уникальность давала способ навредить: партнёр, объявивший чужой номер
     * первым, не пускал на площадку настоящего владельца карты. От вранья она при этом
     * не защищала вовсе — соврать можно и первым.
     *
     * Индекс остаётся обычным: по номеру разбирают обращения в поддержку.
     */
    index('sim_cards_msisdn_idx').on(t.msisdn),
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

    /**
     * Вход линии — у шлюза в режиме `port`
     * ([ADR-0054](../../../../docs/adr/0054-vhod-po-liniyam-goip.md)): `pt-a1b2c3d4e5f6`
     * и `MD5(имя:realm:пароль)`, как у шлюза. Пусто — вход линии не выдан.
     */
    sipUsername: text(),
    a1Hash: text(),

    /** Где и когда линия регистрировалась последний раз — как у шлюза, но по линии. */
    nodeId: idRef<'node'>().references(() => nodes.id, { onDelete: 'set null' }),
    registeredAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('gateway_ports_state_check', oneOf(t.state, GATEWAY_PORT_STATES)),
    // Имя без хеша — вход, который каталог отдал бы без проверки пароля; хеш без имени —
    // вход, под которым не войти.
    check(
      'gateway_ports_credentials_together',
      sql`(${t.sipUsername} is null) = (${t.a1Hash} is null)`,
    ),
    uniqueIndex('gateway_ports_sip_username_key')
      .on(t.sipUsername)
      .where(sql`${t.sipUsername} is not null`),
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

    /**
     * Через что уходит вызов по этому приоритету
     * ([ADR-0040](../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)).
     *
     * Единица приоритета — **предложение**, то есть партнёр вместе со способом
     * терминации: у партнёра с SIM и транком это две отдельные строки, потому что
     * и цены у них разные, и решение клиента о них разное.
     *
     * Умолчание `sim` нужно миграции: на её момент другого способа не существует,
     * и все заведённые приоритеты — про SIM.
     */
    terminationKind: text().$type<TerminationKind>().notNull().default('sim'),

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
    check(
      'channel_partner_priorities_termination_kind_check',
      oneOf(t.terminationKind, TERMINATION_KINDS),
    ),
    // Одно предложение в канале ровно с одним приоритетом: два означали бы, что порядок
    // перебора зависит от того, какую строку прочитали первой. Ключ включает способ
    // терминации — SIM и транк одного партнёра это разные предложения (ADR-0040).
    uniqueIndex('channel_partner_priorities_channel_offer_key').on(
      t.channelId,
      t.partnerId,
      t.terminationKind,
    ),
    // Горячий путь: отбор кандидатов сразу в нужном порядке.
    index('channel_partner_priorities_order_idx').on(t.channelId, t.priority, t.lastRoutedAt),
  ],
);

/**
 * Подробности SIP-транка ([ADR-0039](../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
 *
 * Отдельной таблицей, а не колонками в `gateways`: они осмысленны ровно при одном
 * значении `type`, и в общей таблице были бы пустыми полями, о которых надо помнить
 * ([ADR-0016](../../../docs/adr/0016-soglasheniya-shemy-bd.md)).
 *
 * Ключ — сам шлюз: один транк это один шлюз, и отдельный идентификатор означал бы,
 * что бывает транк без шлюза или два транка на одном.
 */
export const sipTrunks = pgTable(
  'sip_trunks',
  {
    gatewayId: idRef<'gateway'>()
      .primaryKey()
      // Подробности транка без самого шлюза не значат ничего.
      .references(() => gateways.id, { onDelete: 'cascade' }),

    /** Куда отправлять вызовы: `sip.provider.ru` либо `sip.provider.ru:5070`. */
    proxyHost: text().notNull(),

    /**
     * Регистрируемся ли мы у провайдера.
     *
     * Провайдеры пускают двумя способами: регистрацией с именем и паролем либо
     * по адресу источника без неё. Поддерживаются оба — поддержка только регистрации
     * отсекла бы половину провайдеров.
     */
    registersOutbound: boolean().notNull().default(true),

    /** Имя для исходящей регистрации. Пусто при доступе по адресу. */
    outboundUsername: text(),

    /**
     * Пароль провайдера — **зашифрованный**, а не хешированный.
     *
     * Это единственный пароль в проекте, который надо предъявить наружу: без открытого
     * значения к провайдеру не зарегистрироваться. Шифруется тем же способом, что секрет
     * второго фактора ([ADR-0028](../../../docs/adr/0028-vtoroy-faktor.md)) — утечка одной
     * только базы его не раскрывает. Расшифрованное значение уходит **только узлу**.
     */
    outboundSecret: text(),

    /**
     * Ёмкость в одновременных вызовах. Ограничение договорное: провайдер продаёт каналы,
     * и превышение он отвергает, а вызовы срываются молча.
     */
    maxConcurrentCalls: integer().notNull().default(DEFAULT_TRUNK_CONCURRENT_CALLS),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'sip_trunks_concurrency_range',
      sql`${t.maxConcurrentCalls} between 1 and ${sql.raw(String(MAX_TRUNK_CONCURRENT_CALLS))}`,
    ),
    // Регистрация без имени и пароля не состоится, и транк молча не поднялся бы:
    // узел записал бы ошибку, а платформа продолжала бы считать его годным.
    check(
      'sip_trunks_registration_needs_credentials',
      sql`not ${t.registersOutbound} or (${t.outboundUsername} is not null and ${t.outboundSecret} is not null)`,
    ),
  ],
);

/**
 * Регионы, в которые партнёр готов принимать вызовы ([ADR-0022](../../../docs/adr/0022-pokrytie-regionov.md)).
 *
 * **Отсутствие строк означает «все регионы».** Появилась хоть одна — список закрыт:
 * регион, которого в нём нет, к этому партнёру не маршрутизируется. Отдельного поля
 * «режим» нет намеренно: режим выражается наличием строк, как и у приоритетов канала.
 *
 * Регион хранится дважды: `region` — как написал партнёр, для показа; `region_key` —
 * приведённое написание, по которому идёт сравнение. Источники пишут регион по-разному
 * (`Красноярский край`, `Красноярский кр.`), и сравнение строк напрямую означало бы,
 * что партнёр объявил покрытие, а вызовов не получает.
 */
export const partnerCoverage = pgTable(
  'partner_coverage',
  {
    id: primaryId<'partnerCoverage'>(),

    partnerId: idRef<'partner'>()
      .notNull()
      // Покрытие удалённого партнёра не значит ничего и никому не нужно.
      .references(() => partners.id, { onDelete: 'cascade' }),

    /** Название так, как его ввёл партнёр. Показывается ему же. */
    region: text().notNull(),

    /**
     * Приведённое написание (`regionKeyOf`) — первый ключ набора.
     *
     * По нему идёт сравнение с регионом номера, а регион номера — **набор** субъектов
     * ([ADR-0033](../../../docs/adr/0033-region-eto-mnozhestvo.md)): подходит партнёр,
     * объявивший любой из названных.
     */
    regionKey: text().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    // Пустой ключ совпал бы с другим пустым и связал два разных региона.
    check('partner_coverage_key_not_empty', sql`length(${t.regionKey}) > 0`),
    uniqueIndex('partner_coverage_partner_region_key').on(t.partnerId, t.regionKey),
  ],
);

/**
 * Операторы, на которых каналу разрешено звонить
 * ([ADR-0025](../../../docs/adr/0025-razreshyonnye-operatory-kanala.md)).
 *
 * **Отсутствие строк означает «все операторы».** Правило то же, что у приоритетов
 * партнёров и покрытия партнёра по регионам, и по той же причине: новый канал, не смогший
 * позвонить до заполнения списка, выглядел бы поломкой платформы, а не своей настройкой.
 *
 * Сравнивается **определённый** оператор номера, а не префикс: из-за переносимости
 * номеров префикс называет не того оператора (ADR-0013).
 */
export const channelAllowedOperators = pgTable(
  'channel_allowed_operators',
  {
    id: primaryId<'channelAllowedOperator'>(),

    channelId: idRef<'channel'>()
      .notNull()
      // Список удалённого канала не значит ничего и никому не нужен.
      .references(() => channels.id, { onDelete: 'cascade' }),

    operatorId: idRef<'operator'>()
      .notNull()
      // Оператор, на которого кто-то ссылается, не удаляется: иначе список молча
      // расширился бы, а звонки пошли бы туда, куда клиент их не разрешал.
      .references(() => operators.id, { onDelete: 'restrict' }),

    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('channel_allowed_operators_key').on(t.channelId, t.operatorId)],
);
