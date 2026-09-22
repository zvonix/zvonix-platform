/**
 * Очередь писем и одноразовые токены ([ADR-0029](../../../docs/adr/0029-pochta.md)).
 *
 * Письмо кладётся сюда **той же транзакцией**, что и породившее его событие: иначе
 * возможны два состояния, в которых система врёт человеку, — «токен есть, письма нет»
 * и «письмо ушло, токена нет».
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  AUTH_TOKEN_PURPOSES,
  OUTBOX_STATUSES,
  type AuthTokenPurpose,
  type OutboxStatus,
} from '@zvonix/shared';
import { createdAt, idRef, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';
import { users } from './users.js';

/** Письмо, ожидающее отправки. */
export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: primaryId<'outboxMessage'>(),

    /** Кому. Адрес, а не ссылка на пользователя: письмо переживает удаление записи. */
    recipient: text().notNull(),

    subject: text().notNull(),

    /**
     * Тело письма. Текст, без HTML: транзакционному письму разметка не нужна, а вёрстка
     * под полтора десятка почтовых клиентов и спам-фильтры — нужна ещё меньше.
     *
     * В логи не попадает никогда: здесь лежит одноразовый токен, а лог хранится дольше.
     */
    body: text().notNull(),

    /** Зачем письмо: по нему видно, чего именно не доходит, когда почта сломалась. */
    kind: text().notNull(),

    status: text().$type<OutboxStatus>().notNull().default('pending'),

    /** Когда пробовать в следующий раз. Отодвигается с удвоением после каждой неудачи. */
    sendAfter: timestamptz().notNull().defaultNow(),

    attempts: integer().notNull().default(0),

    /** Текст последней ошибки: без него «не отправилось» неотличимо от «не пробовали». */
    lastError: text(),

    sentAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('outbox_messages_status_check', oneOf(t.status, OUTBOX_STATUSES)),
    check('outbox_messages_attempts_non_negative', sql`${t.attempts} >= 0`),
    // Горячий путь воркера: что пора отправлять.
    index('outbox_messages_due_idx').on(t.status, t.sendAfter),
    // Предел писем на один адрес ([ADR-0030](../../../docs/adr/0030-predel-pisem-na-adres.md)):
    // счёт писем на получателя за окно. Спрашивается на каждое письмо.
    index('outbox_messages_recipient_idx').on(t.recipient, t.createdAt),
  ],
);

/**
 * Одноразовый токен, ушедший человеку письмом.
 *
 * Хранится **хеш**, как у сессий: утечка таблицы не даёт ни войти, ни сменить пароль.
 * Сам токен существует только в письме.
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: primaryId<'authToken'>(),

    userId: idRef<'user'>()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    purpose: text().$type<AuthTokenPurpose>().notNull(),

    /** SHA-256 от токена. Сам токен в базе не появляется. */
    tokenHash: text().notNull(),

    expiresAt: timestamptz().notNull(),

    /** Отметка об использовании: токен действует ровно один раз. */
    usedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('auth_tokens_purpose_check', oneOf(t.purpose, AUTH_TOKEN_PURPOSES)),
    uniqueIndex('auth_tokens_hash_key').on(t.tokenHash),
    index('auth_tokens_user_idx').on(t.userId, t.purpose),
    // Уборка по сроку ходит по этой колонке.
    index('auth_tokens_expiry_idx').on(t.expiresAt),
  ],
);
