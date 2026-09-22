/**
 * Учётные записи и сессии — основание для всего остального (этап 0 дорожной карты).
 *
 * `User` — это доступ, а не участник рынка. Клиент и партнёр появятся отдельными
 * сущностями на этапе 1 и будут ссылаться сюда: у одной службы такси может быть
 * несколько сотрудников со своими учётными записями, а роль `support` не имеет
 * ни клиента, ни партнёра вовсе.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  inet,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { USER_ROLES, USER_STATUSES, type UserRole, type UserStatus } from '@zvonix/shared';
import { createdAt, idRef, oneOf, primaryId, timestamptz, updatedAt } from '../columns.js';

export const users = pgTable(
  'users',
  {
    id: primaryId<'user'>(),

    /**
     * Адрес хранится только в нижнем регистре: сравнение адресов регистронезависимо,
     * и уникальность обязана работать так же. Приводит приложение, а база проверяет —
     * без этого «Ivan@…» и «ivan@…» станут двумя учётными записями.
     */
    email: text().notNull(),

    /**
     * Хеш пароля (argon2id). Сам пароль в системе не существует ни на минуту:
     * ни в базе, ни в логах, ни в очередях.
     */
    passwordHash: text().notNull(),

    /** Отображаемое имя. Для партнёра клиенту оно недоступно — клиент видит только псевдоним. */
    fullName: text().notNull(),

    role: text().$type<UserRole>().notNull(),
    status: text().$type<UserStatus>().notNull().default('pending'),

    /**
     * Секрет второго фактора. Хранится отдельно от признака включения: секрет создаётся
     * при начале настройки, а фактором становится только после подтверждения кодом.
     */
    /**
     * Когда адрес подтверждён письмом.
     *
     * Подтверждение **не** переводит запись в `active`: партнёра до сих пор допускает
     * администратор, и связать это с почтой значило бы пустить в систему любого,
     * у кого есть почтовый ящик ([ADR-0029](../../../docs/adr/0029-pochta.md)).
     */
    emailConfirmedAt: timestamptz(),

    totpSecret: text(),
    totpConfirmedAt: timestamptz(),

    /**
     * Номер последнего принятого шага TOTP.
     *
     * RFC 6238 требует не принимать один код дважды: без этого подсмотренный код
     * работает все свои тридцать секунд, а «подсмотренный» — не гипотеза: код диктуют
     * по телефону и вставляют не в то окно
     * ([ADR-0028](../../../docs/adr/0028-vtoroy-faktor.md)).
     */
    totpLastStep: bigint({ mode: 'number' }),

    /**
     * Счётчик неудачных входов подряд и блокировка до указанного момента.
     * Считается в базе, а не в кэше: подбор пароля не должен обнуляться перезапуском
     * или промахом мимо узла.
     */
    failedLoginCount: integer().notNull().default(0),
    lockedUntil: timestamptz(),

    lastLoginAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_role_check', oneOf(t.role, USER_ROLES)),
    check('users_status_check', oneOf(t.status, USER_STATUSES)),
    // Второй фактор нельзя считать подтверждённым, если секрета нет: иначе вход
    // потребует код, которого никто не может сгенерировать, и запись станет мёртвой.
    check(
      'users_totp_confirmed_requires_secret',
      sql`${t.totpConfirmedAt} is null or ${t.totpSecret} is not null`,
    ),
    index('users_role_status_idx').on(t.role, t.status),
  ],
);

/**
 * Сессия входа.
 *
 * Хранится хеш токена, а не токен: утечка таблицы не должна давать возможность войти.
 * Сессия не удаляется при выходе, а помечается отозванной — иначе в аудите остаётся
 * дыра ровно там, где чаще всего и нужно разобраться.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryId<'session'>(),

    userId: idRef<'user'>()
      .notNull()
      // Учётные записи не удаляются (есть `disabled`), но если удаление всё же произойдёт,
      // висящие сессии — это работающий доступ к системе без владельца.
      .references(() => users.id, { onDelete: 'cascade' }),

    tokenHash: text().notNull(),

    /** Откуда вошли. Нужно и для аудита, и для показа пользователю списка его сессий. */
    userAgent: text(),
    ip: inet(),

    expiresAt: timestamptz().notNull(),
    revokedAt: timestamptz(),

    /** Обновляется при каждом использовании токена: по нему видно брошенные сессии. */
    lastSeenAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
    // Фоновая уборка просроченных сессий ходит именно по этой колонке.
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);
