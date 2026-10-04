/**
 * Аккаунты MAX партнёров — доступ к мессенджеру для отправки сообщений
 * ([ADR-0071](../../../../docs/adr/0071-soobscheniya-max.md)).
 *
 * Аналог SIM: ресурс партнёра, у которого есть цена, лимиты и состояние. Данные доступа у
 * провайдера (`providerInstanceId`, `providerToken`, `providerApiUrl`) — внутренняя деталь площадки:
 * ни партнёру, ни клиенту они не отдаются никогда.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  MESSENGER_ACCOUNT_STATUSES,
  MESSENGER_PROVIDERS,
  type MessengerAccountStatus,
  type MessengerProviderId,
} from '@zvonix/shared';
import { createdAt, idRef, money, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { partners } from './billing.js';

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
