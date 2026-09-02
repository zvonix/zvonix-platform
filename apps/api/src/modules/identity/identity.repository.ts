/**
 * Единственная точка обращения к таблицам учётных записей и сессий.
 *
 * Разделение по CONVENTIONS.md: сервис знает правила, репозиторий — запросы.
 * Без этого запросы расползаются по сервисам, и «где меняется статус пользователя»
 * перестаёт быть вопросом с одним ответом.
 */

import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { sessions, users } from '@zvonix/db/schema';
import { toDatabaseError } from '@zvonix/db';
import type { Id, UserRole, UserStatus } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type UserId = Id<'user'>;
export type SessionId = Id<'session'>;

export type UserRow = typeof users.$inferSelect;
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

/** Сессия вместе с владельцем: проверка доступа всегда нужна вместе с ролью и статусом. */
export interface SessionWithUser {
  readonly session: SessionRow;
  readonly user: UserRow;
}

@Injectable()
export class IdentityRepository {
  constructor(private readonly database: DatabaseService) {}

  async createUser(draft: NewUser): Promise<UserRow> {
    try {
      const [row] = await this.database.db.insert(users).values(draft).returning();
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
  async revokeAllSessions(userId: UserId, at: Date): Promise<number> {
    const revoked = await this.database.db
      .update(sessions)
      .set({ revokedAt: at })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
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
