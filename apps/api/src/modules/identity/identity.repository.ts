/**
 * Единственная точка обращения к таблицам учётных записей и сессий.
 *
 * Разделение по CONVENTIONS.md: сервис знает правила, репозиторий — запросы.
 * Без этого запросы расползаются по сервисам, и «где меняется статус пользователя»
 * перестаёт быть вопросом с одним ответом.
 */

import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { authTokens, sessions, users } from '@zvonix/db/schema';
import { containsIgnoringCase, toDatabaseError, type Database, type Executor } from '@zvonix/db';
import {
  newId,
  type AuthTokenPurpose,
  type Id,
  type UserRole,
  type UserStatus,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type UserId = Id<'user'>;
export type SessionId = Id<'session'>;

export type UserRow = typeof users.$inferSelect;
export type AuthTokenRow = typeof authTokens.$inferSelect;

/** Исполнитель запроса: пул или транзакция. */
// Тип объявлен в `@zvonix/db` и переэкспортируется отсюда: вызывающий берёт его
// там же, где метод, а определение остаётся одно на весь проект.
export type { Executor };
export type SessionRow = typeof sessions.$inferSelect;

export interface NewUser {
  readonly id: UserId;
  readonly email: string;
  readonly passwordHash: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly status: UserStatus;
}

export interface NewSession {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

/**
 * Отбор для списка учётных записей.
 *
 * Пустое поле означает «любое», а не «пустое»: закрытый список значений с отдельным
 * значением «все» здесь был бы лишним — роль и состояние сами по себе перечисления,
 * и «не задано» от них отличается.
 */
export interface UserFilter {
  readonly role?: UserRole;
  readonly status?: UserStatus;
  /** Часть адреса. Регистр не важен: адреса и хранятся в нижнем. */
  readonly email?: string;
  readonly limit: number;
  readonly offset: number;
}

function userFilterCondition(filter: UserFilter): SQL | undefined {
  const parts: SQL[] = [];
  if (filter.role !== undefined) parts.push(eq(users.role, filter.role));
  if (filter.status !== undefined) parts.push(eq(users.status, filter.status));
  // Адреса латинские, и локаль сравнения им безразлична — но правило поиска
  // в проекте одно на всех, чтобы не приходилось помнить, где оно важно.
  if (filter.email !== undefined && filter.email !== '') {
    parts.push(containsIgnoringCase(users.email, filter.email));
  }
  return parts.length === 0 ? undefined : and(...parts);
}

/** Сессия вместе с владельцем: проверка доступа всегда нужна вместе с ролью и статусом. */
export interface SessionWithUser {
  readonly session: SessionRow;
  readonly user: UserRow;
}

@Injectable()
export class IdentityRepository {
  constructor(private readonly database: DatabaseService) {}

  async createUser(draft: NewUser, executor: Executor = this.database.db): Promise<UserRow> {
    try {
      const [row] = await executor.insert(users).values(draft).returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      // Нарушение уникальности адреса станет `conflict`, а текст PostgreSQL
      // с самим адресом наружу не уйдёт.
      throw toDatabaseError(cause);
    }
  }

  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await this.database.db.select().from(users).where(eq(users.email, email));
    return row;
  }

  async findById(id: UserId): Promise<UserRow | undefined> {
    const [row] = await this.database.db.select().from(users).where(eq(users.id, id));
    return row;
  }

  /** Учётные записи по списку идентификаторов. Пустой список — пустой ответ, без запроса. */
  async findByIds(ids: readonly UserId[]): Promise<UserRow[]> {
    if (ids.length === 0) return [];
    return this.database.db
      .select()
      .from(users)
      .where(inArray(users.id, [...ids]));
  }

  /**
   * Учётные записи по отбору — для администратора.
   *
   * Возвращает и страницу, и полное число подходящих записей: без второго в интерфейсе
   * остаётся бесконечная прокрутка, а на странице, откуда допускают до денег, человек
   * должен видеть, сколько всего заявок ждёт ([DESIGN.md](../../../../../docs/DESIGN.md)).
   *
   * Счёт идёт отдельным запросом, а не оконной функцией: `count(*) over ()` считает
   * то же самое, но заставляет базу протащить его через каждую строку страницы,
   * и на пустой странице ответа не даёт вовсе.
   */
  async listUsers(filter: UserFilter): Promise<{ rows: UserRow[]; total: number }> {
    const where = userFilterCondition(filter);

    const rows = await this.database.db
      .select()
      .from(users)
      .where(where)
      // По убыванию времени создания: новая заявка на регистрацию — то, ради чего
      // на этот список чаще всего и приходят.
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(filter.limit)
      .offset(filter.offset);

    const [counted] = await this.database.db.select({ total: count() }).from(users).where(where);

    return { rows, total: counted?.total ?? 0 };
  }

  /**
   * Счётчик неудачных входов увеличивается в базе выражением `+ 1`, а не чтением
   * и записью в приложении: параллельные попытки подбора иначе затирают друг друга,
   * и блокировка не наступает никогда.
   */
  async registerFailedLogin(id: UserId, lockUntil: Date | null): Promise<void> {
    await this.database.db
      .update(users)
      .set({
        failedLoginCount: sql`${users.failedLoginCount} + 1`,
        lockedUntil: lockUntil,
      })
      .where(eq(users.id, id));
  }

  async registerSuccessfulLogin(id: UserId, at: Date): Promise<void> {
    await this.database.db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: at })
      .where(eq(users.id, id));
  }

  /**
   * Сколько учётных записей с ролью администратора — в любом состоянии: заблокированный
   * администратор тоже закрывает первый запуск (ADR-0050), иначе блокировка единственного
   * администратора снова открывала бы форму заведения по коду.
   */
  async countAdmins(executor: Executor = this.database.db): Promise<number> {
    const [counted] = await executor
      .select({ total: count() })
      .from(users)
      .where(eq(users.role, 'admin'));
    return counted?.total ?? 0;
  }

  /**
   * Очередь первого запуска: проверка «администратора нет» и заведение идут под одной
   * блокировкой. Без неё две формы с верным кодом, отправленные одновременно, обе увидели
   * бы пустоту и завели двух администраторов.
   */
  async lockFirstRun(executor: Executor): Promise<void> {
    await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended('first-run', 0))`);
  }

  /** Пул: нужен службе, чтобы писать токен и письмо одной транзакцией (ADR-0029). */
  get db(): Database {
    return this.database.db;
  }

  /**
   * Заводит одноразовый токен.
   *
   * `executor` передаётся всегда, когда токен пишется вместе с письмом о нём: иначе
   * возможны «токен есть, письма нет» и «письмо ушло, токена нет».
   */
  async createAuthToken(
    draft: {
      userId: UserId;
      purpose: AuthTokenPurpose;
      tokenHash: string;
      expiresAt: Date;
    },
    executor: Executor = this.database.db,
  ): Promise<AuthTokenRow> {
    try {
      const [row] = await executor
        .insert(authTokens)
        .values({ id: newId<'authToken'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Гасит прежние токены того же назначения.
   *
   * Второй запрос восстановления делает первую ссылку недействительной: иначе письмо
   * недельной давности, попавшее не в те руки, работает наравне со свежим.
   */
  async expireAuthTokens(
    userId: UserId,
    purpose: AuthTokenPurpose,
    at: Date,
    executor: Executor = this.database.db,
  ): Promise<number> {
    const updated = await executor
      .update(authTokens)
      .set({ usedAt: at })
      .where(
        and(
          eq(authTokens.userId, userId),
          eq(authTokens.purpose, purpose),
          isNull(authTokens.usedAt),
        ),
      )
      .returning({ id: authTokens.id });
    return updated.length;
  }

  /** Действующий токен вместе с его пользователем. */
  async findLiveAuthToken(
    tokenHash: string,
    purpose: AuthTokenPurpose,
    now: Date,
  ): Promise<{ token: AuthTokenRow; user: UserRow } | undefined> {
    const [row] = await this.database.db
      .select({ token: authTokens, user: users })
      .from(authTokens)
      .innerJoin(users, eq(users.id, authTokens.userId))
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash),
          eq(authTokens.purpose, purpose),
          isNull(authTokens.usedAt),
          gt(authTokens.expiresAt, now),
        ),
      );
    return row;
  }

  /**
   * Отмечает токен использованным.
   *
   * Условие «ещё не использован» стоит в самом запросе: два одновременных перехода
   * по одной ссылке иначе оба прошли бы проверку.
   */
  async useAuthToken(
    id: Id<'authToken'>,
    at: Date,
    executor: Executor = this.database.db,
  ): Promise<boolean> {
    const updated = await executor
      .update(authTokens)
      .set({ usedAt: at })
      .where(and(eq(authTokens.id, id), isNull(authTokens.usedAt)))
      .returning({ id: authTokens.id });
    return updated.length > 0;
  }

  /** Убирает просроченные токены: в них нет смысла, а строки копятся. */
  async deleteExpiredAuthTokens(now: Date, limit: number): Promise<number> {
    const stale = await this.database.db
      .select({ id: authTokens.id })
      .from(authTokens)
      .where(lt(authTokens.expiresAt, now))
      .limit(limit);
    if (stale.length === 0) return 0;

    const removed = await this.database.db
      .delete(authTokens)
      .where(
        inArray(
          authTokens.id,
          stale.map((row) => row.id),
        ),
      )
      .returning({ id: authTokens.id });
    return removed.length;
  }

  /** Отметка о подтверждённом адресе. Доступ она не открывает — это дело админа. */
  async setEmailConfirmed(id: UserId, at: Date): Promise<UserRow | undefined> {
    const [row] = await this.database.db
      .update(users)
      .set({ emailConfirmedAt: at })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  /** Новый пароль. Отдельным запросом: смена пароля не трогает ничего больше. */
  async setPasswordHash(id: UserId, passwordHash: string): Promise<UserRow | undefined> {
    const [row] = await this.database.db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  /**
   * Записывает секрет второго фактора.
   *
   * `confirmedAt` пустой означает «подключение начато, но не доведено»: до подтверждения
   * кодом второй фактор не действует, иначе человек запер бы себя, не проверив,
   * что аутентификатор вообще показывает верные коды.
   */
  async setTotpSecret(id: UserId, secret: string | null): Promise<UserRow | undefined> {
    const [row] = await this.database.db
      .update(users)
      .set({ totpSecret: secret, totpConfirmedAt: null, totpLastStep: null })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  async confirmTotp(id: UserId, at: Date, step: number): Promise<UserRow | undefined> {
    const [row] = await this.database.db
      .update(users)
      .set({ totpConfirmedAt: at, totpLastStep: step })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  /**
   * Отмечает принятый шаг.
   *
   * Условие «шаг больше записанного» стоит в самом запросе: без него два одновременных
   * входа с одним кодом оба прошли бы проверку и оба записали бы шаг — то есть
   * повторное использование, ради запрета которого шаг и хранится.
   */
  async markTotpStep(id: UserId, step: number): Promise<boolean> {
    const updated = await this.database.db
      .update(users)
      .set({ totpLastStep: step })
      .where(and(eq(users.id, id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
      .returning({ id: users.id });
    return updated.length > 0;
  }

  async setStatus(id: UserId, status: UserStatus): Promise<UserRow> {
    const [row] = await this.database.db
      .update(users)
      .set({ status })
      .where(eq(users.id, id))
      .returning();
    if (row === undefined) throw new Error('Обновление не вернуло строку');
    return row;
  }

  async createSession(draft: NewSession): Promise<SessionRow> {
    try {
      const [row] = await this.database.db.insert(sessions).values(draft).returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Действующая сессия по хешу токена.
   *
   * Отозванные и просроченные отсекаются в запросе, а не в коде: условие доступа
   * должно быть одно, и проверять его после выборки — значит однажды забыть.
   */
  async findLiveSession(tokenHash: string, now: Date): Promise<SessionWithUser | undefined> {
    const [row] = await this.database.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      );
    return row;
  }

  async touchSession(id: SessionId, at: Date): Promise<void> {
    await this.database.db.update(sessions).set({ lastSeenAt: at }).where(eq(sessions.id, id));
  }

  /** Возвращает `true`, если сессия существовала и была действующей. */
  async revokeSession(id: SessionId, at: Date): Promise<boolean> {
    const revoked = await this.database.db
      .update(sessions)
      .set({ revokedAt: at })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return revoked.length > 0;
  }

  /** Закрывает все сессии пользователя: смена пароля, блокировка, действие администратора. */
  /**
   * Закрывает сессии пользователя.
   *
   * `keepSessionId` оставляет одну — ту, из которой действуют. Смена пароля закрывает
   * прочие устройства, но не то, за которым человек сидит: иначе он научится пароли
   * не менять ([ADR-0028](../../../../../docs/adr/0028-vtoroy-faktor.md)).
   */
  async revokeAllSessions(
    userId: UserId,
    at: Date,
    options: { keepSessionId?: SessionId } = {},
  ): Promise<number> {
    const revoked = await this.database.db
      .update(sessions)
      .set({ revokedAt: at })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          ...(options.keepSessionId === undefined ? [] : [ne(sessions.id, options.keepSessionId)]),
        ),
      )
      .returning({ id: sessions.id });
    return revoked.length;
  }

  /**
   * Удаляет сессии, срок которых истёк.
   *
   * Удаляет, а не помечает: сессия хранит адрес и клиента, то есть данные о человеке,
   * и держать их после того, как сессия перестала действовать, незачем. След о входе
   * и выходе остаётся в журнале аудита — там он и нужен.
   *
   * Партиями: одна `DELETE` по нескольким миллионам строк держит блокировки и раздувает
   * журнал упреждающей записи. Фоновый проход догоняющий и заберёт остаток следующим тиком.
   */
  async deleteExpiredSessions(now: Date, limit: number): Promise<number> {
    const doomed = await this.database.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(lt(sessions.expiresAt, now))
      .limit(limit);

    if (doomed.length === 0) return 0;

    const removed = await this.database.db
      .delete(sessions)
      .where(
        inArray(
          sessions.id,
          doomed.map((row) => row.id),
        ),
      )
      .returning({ id: sessions.id });
    return removed.length;
  }

  async listLiveSessions(userId: UserId, now: Date): Promise<SessionRow[]> {
    return this.database.db
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
      );
  }
}
