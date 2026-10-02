/**
 * Платежи клиентов: заявки на пополнение счёта
 * ([ADR-0064](../../../../docs/adr/0064-platezhi-karkas.md)).
 *
 * Деньги здесь не живут: платёж — это **заявка и её исход**. Сами деньги появляются на
 * счёте клиента проводкой с ключом `payment:<идентификатор>` (модуль `billing`), и по этому
 * ключу платёж связан с книгой без отдельной колонки.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  type PaymentProviderId,
  type PaymentStatus,
} from '@zvonix/shared';
import { createdAt, idRef, money, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { clients } from './billing.js';
import { users } from './users.js';

export const payments = pgTable(
  'payments',
  {
    id: primaryId<'payment'>(),

    /** Чей счёт пополняется. Клиент с платежами не удаляется: платёж — основание проводки. */
    clientId: idRef<'client'>()
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),

    provider: text().$type<PaymentProviderId>().notNull(),
    status: text().$type<PaymentStatus>().notNull().default('pending'),

    /** Сколько клиент собирался перевести. */
    amount: money().notNull(),

    /**
     * Сколько фактически зачислено. Пусто, пока платёж не `succeeded`. Может отличаться от
     * заявленного: перевели иначе, чем писали, и зачислять надо то, что пришло.
     */
    receivedAmount: money(),

    /** Идентификатор платежа у платёжной системы; у ручного способа пусто. */
    externalId: text(),

    /** Пометка клиента: номер платёжки, за что. Помогает администратору найти перевод. */
    comment: text(),

    /** Почему отклонена — для клиента и для разбора. */
    resolutionNote: text(),

    createdByUserId: idRef<'user'>().references(() => users.id, { onDelete: 'set null' }),

    /** Кто подтвердил или отклонил. Пусто у платежа, решённого платёжной системой. */
    resolvedByUserId: idRef<'user'>().references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('payments_status_check', oneOf(t.status, PAYMENT_STATUSES)),
    check('payments_provider_check', oneOf(t.provider, PAYMENT_PROVIDERS)),
    check('payments_amount_positive', sql`${t.amount} > 0`),
    check(
      'payments_received_positive',
      sql`${t.receivedAmount} is null or ${t.receivedAmount} > 0`,
    ),
    // Зачисленный платёж обязан знать, сколько зачислено; незавершённый — нет.
    check(
      'payments_received_matches_status',
      sql`(${t.status} = 'succeeded') = (${t.receivedAmount} is not null)`,
    ),
    // Одно уведомление платёжной системы — один платёж: повторная доставка не заводит второй.
    uniqueIndex('payments_external_key')
      .on(t.provider, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('payments_client_idx').on(t.clientId, t.createdAt),
    // Очередь администратора: что ждёт подтверждения.
    index('payments_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);
