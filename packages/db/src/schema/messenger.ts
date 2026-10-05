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
  MESSENGER_ACCOUNT_STATUSES,
  MESSENGER_PROVIDERS,
  type MessageChannel,
  type MessageFailureReason,
  type MessageStatus,
  type MessengerAccountStatus,
  type MessengerProviderId,
} from '@zvonix/shared';
import { createdAt, idRef, money, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { clients, partners } from './billing.js';

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

    /**
     * Цена партнёра за одно сообщение, микроединицы. Пусто — цена не назначена, аккаунт
     * сообщений не принимает (как SIM без цены на номер).
     */
    price: money(),

    /** Лимиты отправки; пусто — без ограничения. Сообщение сверх лимита ждёт, а не отклоняется. */
    limitPerMinute: integer(),
    limitPerDay: integer(),

    /** Когда аккаунт отправлял последний раз: от неё зависит пауза и порядок выбора. */
    lastUsedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('messenger_accounts_status_check', oneOf(t.status, MESSENGER_ACCOUNT_STATUSES)),
    check('messenger_accounts_provider_check', oneOf(t.provider, MESSENGER_PROVIDERS)),
    check('messenger_accounts_price_positive', sql`${t.price} is null or ${t.price} > 0`),
    check(
      'messenger_accounts_limits_positive',
      sql`(${t.limitPerMinute} is null or ${t.limitPerMinute} > 0) and (${t.limitPerDay} is null or ${t.limitPerDay} > 0)`,
    ),
    uniqueIndex('messenger_accounts_instance_key').on(t.provider, t.providerInstanceId),
    index('messenger_accounts_partner_idx').on(t.partnerId),
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
    /** Когда отчёт о доставке принят клиентом SMPP; пусто — ещё не отдан. */
    receiptSentAt: timestamptz(),

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
    // Отчёты SMPP, которые ещё предстоит отдать: опрос читает только их.
    index('messages_receipt_idx')
      .on(t.clientId, t.createdAt)
      .where(sql`${t.channel} = 'smpp' and ${t.receiptSentAt} is null`),
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
    /** Последний удачный вход: поддержке и клиенту видно, подключался ли он вообще. */
    lastBindAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('smpp_accounts_client_key').on(t.clientId),
    uniqueIndex('smpp_accounts_system_id_key').on(t.systemId),
  ],
);
