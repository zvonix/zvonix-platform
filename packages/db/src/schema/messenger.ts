/**
 * Аккаунты MAX партнёров — доступ к мессенджеру для отправки сообщений
 * ([ADR-0071](../../../../docs/adr/0071-soobscheniya-max.md)).
 *
 * Аналог SIM: ресурс партнёра, у которого есть цена, лимиты и состояние. Данные доступа у
 * провайдера (`providerInstanceId`, `providerToken`, `providerApiUrl`) — внутренняя деталь площадки:
 * ни партнёру, ни клиенту они не отдаются никогда.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  MESSAGE_CHANNELS,
  MESSAGE_FAILURE_REASONS,
  MESSAGE_STATUSES,
  MESSENGER_ACCOUNT_REASONS,
  MESSENGER_ACCOUNT_STATUSES,
  BOT_KINDS,
  BOT_STATUSES,
  BOT_SUBSCRIBER_STATES,
  MESSENGER_PROVIDERS,
  SMPP_RECEIPT_ACTIONS,
  SMPP_RECEIPT_DEFAULTS,
  type BotKind,
  type BotStatus,
  type BotSubscriberState,
  type MessageChannel,
  type MessageFailureReason,
  type MessageStatus,
  type MessengerAccountReason,
  type MessengerAccountStatus,
  type MessengerProviderId,
  type SmppReceiptAction,
} from '@zvonix/shared';
import { createdAt, idRef, money, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { clients, partners } from './billing.js';

/**
 * Тариф MAX ([ADR-0075](../../../../docs/adr/0075-tarify-max-nabor-uslovij.md)): именованный набор условий партнёра —
 * цена за сообщение и лимиты отправки. Назначается аккаунту; аккаунт без своего тарифа берёт тариф партнёра
 * «по умолчанию» (один на партнёра), как SIM у тарифов звонков (ADR-0056).
 */
export const messengerTariffs = pgTable(
  'messenger_tariffs',
  {
    id: primaryId<'messengerTariff'>(),
    partnerId: idRef<'partner'>()
      .notNull()
      .references(() => partners.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    /** Цена партнёра за одно сообщение, микроединицы. */
    price: money().notNull(),
    /** Лимиты отправки; пусто — без ограничения. Сообщение сверх лимита ждёт, а не отклоняется. */
    limitPerMinute: integer(),
    limitPerDay: integer(),
    isDefault: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('messenger_tariffs_name_length', sql`char_length(${t.name}) between 1 and 60`),
    check('messenger_tariffs_price_positive', sql`${t.price} > 0`),
    check(
      'messenger_tariffs_limits_positive',
      sql`(${t.limitPerMinute} is null or ${t.limitPerMinute} > 0) and (${t.limitPerDay} is null or ${t.limitPerDay} > 0)`,
    ),
    // Имя уникально у партнёра без учёта регистра; регистр приводится в локали ICU (ADR-0038).
    uniqueIndex('messenger_tariffs_partner_name_idx').on(
      t.partnerId,
      sql`lower(${t.name} collate "und-x-icu")`,
    ),
    uniqueIndex('messenger_tariffs_default_idx')
      .on(t.partnerId)
      .where(sql`${t.isDefault}`),
  ],
);

export const messengerAccounts = pgTable(
  'messenger_accounts',
  {
    id: primaryId<'messengerAccount'>(),

    /** Чей аккаунт. Партнёр с аккаунтами не удаляется: на них ссылаются сообщения. */
    partnerId: idRef<'partner'>()
      .notNull()
      .references(() => partners.id, { onDelete: 'restrict' }),

    /** Как партнёр назвал аккаунт у себя: «Основной», «Вторая SIM». Клиенту не показывается. */
    label: text().notNull(),

    status: text().$type<MessengerAccountStatus>().notNull().default('pending'),

    /** Почему недоступен, по последней сверке; пусто — рабочий или ждёт входа. Только для показа партнёру и сотрудникам. */
    stateReason: text().$type<MessengerAccountReason>(),

    provider: text().$type<MessengerProviderId>().notNull(),

    /** Идентификатор инстанса у провайдера. Уникален: один инстанс — один аккаунт. */
    providerInstanceId: text().notNull(),

    /** Ключ инстанса — **зашифрованный** (`SECRET_KEY`, `zvonix:messenger-token:v1`). */
    providerToken: text().notNull(),

    /** Адрес API инстанса у провайдера (у разных инстансов он разный). */
    providerApiUrl: text().notNull(),

    /** Номер, под которым аккаунт вошёл в MAX. Пусто, пока QR-код не отсканирован. */
    phone: text(),

    /** Когда состояние аккаунта сверялось с провайдером последний раз. */
    stateCheckedAt: timestamptz(),

    /** Назначенный тариф; пусто — действует тариф партнёра по умолчанию ([ADR-0075](../../../../docs/adr/0075-tarify-max-nabor-uslovij.md)). */
    tariffId: idRef<'messengerTariff'>().references(() => messengerTariffs.id, {
      onDelete: 'restrict',
    }),

    /**
     * **Действующие** условия — производные от тарифа (свой → по умолчанию), прямой записи нет: пересчитывает
     * `recomputeTerms` в той же транзакции, что и любое изменение тарифа. Хранятся здесь, чтобы выбор аккаунта
     * под сообщение и сверка лимитов не соединяли таблицы. Цена пуста — аккаунт сообщений не принимает.
     */
    price: money(),
    limitPerMinute: integer(),
    limitPerDay: integer(),

    /** Когда аккаунт отправлял последний раз: от неё зависит пауза и порядок выбора. */
    lastUsedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('messenger_accounts_status_check', oneOf(t.status, MESSENGER_ACCOUNT_STATUSES)),
    check(
      'messenger_accounts_reason_check',
      sql`${t.stateReason} is null or ${oneOf(t.stateReason, MESSENGER_ACCOUNT_REASONS)}`,
    ),
    check('messenger_accounts_provider_check', oneOf(t.provider, MESSENGER_PROVIDERS)),
    check('messenger_accounts_price_positive', sql`${t.price} is null or ${t.price} > 0`),
    check(
      'messenger_accounts_limits_positive',
      sql`(${t.limitPerMinute} is null or ${t.limitPerMinute} > 0) and (${t.limitPerDay} is null or ${t.limitPerDay} > 0)`,
    ),
    uniqueIndex('messenger_accounts_instance_key').on(t.provider, t.providerInstanceId),
    index('messenger_accounts_partner_idx').on(t.partnerId),
    index('messenger_accounts_tariff_idx').on(t.tariffId),
    // Опрос состояния и выбор аккаунта под сообщение читают только живые.
    index('messenger_accounts_live_idx')
      .on(t.status)
      .where(sql`${t.status} <> 'retired'`),
  ],
);

/**
 * Сообщения MAX ([ADR-0071](../../../../docs/adr/0071-soobscheniya-max.md)).
 *
 * Строка — и очередь отправки, и журнал. Деньги фиксируются **при приёме** (цена партнёра, наценка и
 * сумма клиента): смена цены или наценки идущие и отправленные сообщения не затрагивает. Сами деньги —
 * проводка `message:<id>` (возврат — `message_refund:<id>`), здесь только суммы для разбора.
 */
export const messages = pgTable(
  'messages',
  {
    id: primaryId<'message'>(),

    clientId: idRef<'client'>()
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),

    /** Ключ клиента: повторный запрос того же сообщения возвращает прежнее, а не заводит второе. */
    externalId: text(),

    /** Получатель в каноническом виде: одиннадцать цифр с семёрки. */
    recipient: text().notNull(),

    /**
     * Текст. Персональные данные: после срока хранения (`retention.messages_days`) стирается, а строка
     * остаётся — на ней держатся деньги и разбор.
     */
    text: text().notNull(),

    status: text().$type<MessageStatus>().notNull().default('queued'),
    failureReason: text().$type<MessageFailureReason>(),

    /** Аккаунт и партнёр выбираются при приёме (по цене) и дальше не меняются. */
    accountId: idRef<'messengerAccount'>()
      .notNull()
      .references(() => messengerAccounts.id, { onDelete: 'restrict' }),
    partnerId: idRef<'partner'>()
      .notNull()
      .references(() => partners.id, { onDelete: 'restrict' }),

    /** Идентификатор сообщения у провайдера; по нему приходят статусы доставки. */
    providerMessageId: text(),

    /** Деньги, зафиксированные при приёме: клиент платит = партнёру + наценка площадки. */
    clientAmount: money().notNull(),
    partnerAmount: money().notNull(),
    commissionAmount: money().notNull(),

    /** Путь приёма: по `smpp` клиенту отдаётся отчёт о доставке (ADR-0072). */
    channel: text().$type<MessageChannel>().notNull().default('api'),
    /** Когда клиент SMPP принял последний отчёт; пусто — ни одного ещё не отдано. */
    receiptSentAt: timestamptz(),
    /** Какие события уже обработаны для отчётов SMPP: `sent`, `delivered`, `read`, `failed` (ADR-0076). */
    receiptEvents: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    attempts: integer().notNull().default(0),
    /** Не раньше этого момента воркер берёт сообщение (пауза, повтор после сбоя). */
    nextAttemptAt: timestamptz().notNull().defaultNow(),

    createdAt: createdAt(),
    sentAt: timestamptz(),
    deliveredAt: timestamptz(),
    readAt: timestamptz(),
    failedAt: timestamptz(),
  },
  (t) => [
    check('messages_status_check', oneOf(t.status, MESSAGE_STATUSES)),
    check('messages_channel_check', oneOf(t.channel, MESSAGE_CHANNELS)),
    check(
      'messages_failure_reason_check',
      sql`${t.failureReason} is null or ${oneOf(t.failureReason, MESSAGE_FAILURE_REASONS)}`,
    ),
    check(
      'messages_failure_matches_status',
      sql`(${t.status} = 'failed') = (${t.failureReason} is not null)`,
    ),
    check(
      'messages_amounts_check',
      sql`${t.partnerAmount} > 0 and ${t.commissionAmount} >= 0 and ${t.clientAmount} = ${t.partnerAmount} + ${t.commissionAmount}`,
    ),
    uniqueIndex('messages_client_external_key')
      .on(t.clientId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    uniqueIndex('messages_provider_key')
      .on(t.accountId, t.providerMessageId)
      .where(sql`${t.providerMessageId} is not null`),
    index('messages_client_idx').on(t.clientId, t.createdAt),
    // Сообщения SMPP, по которым опрос ищет неотданные отчёты (ADR-0076).
    index('messages_receipt_idx')
      .on(t.clientId, t.createdAt)
      .where(sql`${t.channel} = 'smpp'`),
    index('messages_account_sent_idx').on(t.accountId, t.sentAt),
    // Очередь воркера: что ждёт отправки.
    index('messages_queue_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} in ('queued', 'sending')`),
  ],
);

/**
 * Учётная запись SMPP клиента ([ADR-0072](../../../docs/adr/0072-smpp-dlya-soobscheniy.md)): одна на
 * клиента. Пароль выдаётся один раз и хранится только как хеш (SHA-256 с солью `system_id`).
 */
export const smppAccounts = pgTable(
  'smpp_accounts',
  {
    id: primaryId<'smppAccount'>(),
    clientId: idRef<'client'>()
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    /** Имя для входа, выдаёт площадка. Уникально среди всех клиентов. */
    systemId: text().notNull(),
    passwordHash: text().notNull(),
    /** Разрешённые адреса клиента; пусто — любые. */
    allowedIps: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    enabled: boolean().notNull().default(true),
    /** Что отдать клиенту на событие с сообщением (ADR-0076): ничего, «принято» или «доставлено». */
    receiptOnSent: text().$type<SmppReceiptAction>().notNull().default(SMPP_RECEIPT_DEFAULTS.sent),
    receiptOnDelivered: text()
      .$type<SmppReceiptAction>()
      .notNull()
      .default(SMPP_RECEIPT_DEFAULTS.delivered),
    receiptOnRead: text().$type<SmppReceiptAction>().notNull().default(SMPP_RECEIPT_DEFAULTS.read),
    /** Последний удачный вход: поддержке и клиенту видно, подключался ли он вообще. */
    lastBindAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('smpp_accounts_receipt_on_sent_check', oneOf(t.receiptOnSent, SMPP_RECEIPT_ACTIONS)),
    check(
      'smpp_accounts_receipt_on_delivered_check',
      oneOf(t.receiptOnDelivered, SMPP_RECEIPT_ACTIONS),
    ),
    check('smpp_accounts_receipt_on_read_check', oneOf(t.receiptOnRead, SMPP_RECEIPT_ACTIONS)),
    uniqueIndex('smpp_accounts_client_key').on(t.clientId),
    uniqueIndex('smpp_accounts_system_id_key').on(t.systemId),
  ],
);

/**
 * Бот MAX ([ADR-0077](../../../../docs/adr/0077-bot-max-vtoroy-kanal.md)): бот площадки (один) или бот клиента (по
 * одному на клиента). Токен выдаёт MAX при создании бота в «MAX для бизнеса»; хранится зашифрованным.
 */
export const messengerBots = pgTable(
  'messenger_bots',
  {
    id: primaryId<'messengerBot'>(),
    kind: text().$type<BotKind>().notNull(),
    /** Чей бот — только у бота клиента. */
    clientId: idRef<'client'>().references(() => clients.id, { onDelete: 'restrict' }),
    token: text().notNull(),
    /** Идентификатор, имя и никнейм бота у MAX — из проверки токена; никнейм нужен для ссылки пассажирам. */
    botUserId: text().notNull(),
    name: text().notNull(),
    username: text().notNull(),
    status: text().$type<BotStatus>().notNull().default('active'),
    /** Чем кончилась последняя проверка бота (токен, вебхук); пусто — всё в порядке. */
    lastError: text(),
    lastCheckedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('messenger_bots_kind_check', oneOf(t.kind, BOT_KINDS)),
    check('messenger_bots_status_check', oneOf(t.status, BOT_STATUSES)),
    check('messenger_bots_owner_check', sql`(${t.kind} = 'client') = (${t.clientId} is not null)`),
    // Бот площадки один; у клиента — не больше одного своего.
    uniqueIndex('messenger_bots_platform_key')
      .on(t.kind)
      .where(sql`${t.kind} = 'platform'`),
    uniqueIndex('messenger_bots_client_key')
      .on(t.clientId)
      .where(sql`${t.clientId} is not null`),
  ],
);

/**
 * Подключение клиента к боту: какой бот его, включено ли и по какому коду его пассажиры приходят в бота
 * (ссылка `…?start=<код>`). Цены клиента (необязательные) и период ежемесячной платы добавляются в следующем выпуске.
 */
export const botConnections = pgTable(
  'bot_connections',
  {
    id: primaryId<'botConnection'>(),
    clientId: idRef<'client'>()
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    botId: idRef<'messengerBot'>()
      .notNull()
      .references(() => messengerBots.id, { onDelete: 'restrict' }),
    enabled: boolean().notNull().default(true),
    /** Публичный код клиента для ссылки бота. Случайный, без смысла: по нему нельзя узнать клиента. */
    code: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('bot_connections_client_key').on(t.clientId),
    uniqueIndex('bot_connections_code_key').on(t.code),
  ],
);

/**
 * Подписчик бота — человек, запустивший бота по ссылке клиента. Номер появляется, когда человек сам делится
 * контактом; сообщение уходит боту только подписчику с номером в состоянии `started`.
 */
export const botSubscribers = pgTable(
  'bot_subscribers',
  {
    id: primaryId<'botSubscriber'>(),
    botId: idRef<'messengerBot'>()
      .notNull()
      .references(() => messengerBots.id, { onDelete: 'restrict' }),
    clientId: idRef<'client'>()
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    /** Пользователь и чат MAX, куда писать. */
    maxUserId: text().notNull(),
    chatId: text().notNull(),
    /** Номер из контакта, который человек прислал о себе; пусто — ещё не поделился. */
    phone: text(),
    state: text().$type<BotSubscriberState>().notNull().default('started'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('bot_subscribers_state_check', oneOf(t.state, BOT_SUBSCRIBER_STATES)),
    uniqueIndex('bot_subscribers_user_key').on(t.botId, t.clientId, t.maxUserId),
    // Поиск получателя при отправке: клиент + номер, только живые.
    index('bot_subscribers_phone_idx')
      .on(t.clientId, t.phone)
      .where(sql`${t.phone} is not null and ${t.state} = 'started'`),
  ],
);
