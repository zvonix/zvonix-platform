/**
 * Токены сессий (ADR-0018).
 *
 * Токен — просто случайное число, а не подписанная структура: платформа обязана уметь
 * закрыть доступ немедленно, а отозвать выданный JWT до истечения срока нельзя.
 *
 * В базе лежит SHA-256 от токена, а не сам токен: утечка таблицы не должна давать
 * возможность войти. Медленный хеш здесь не нужен и вреден — токен содержит 256 бит
 * случайности, перебирать нечего, а проверка выполняется на каждом запросе.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 байта — 256 бит энтропии. */
const TOKEN_BYTES = 32;

/** Срок жизни сессии. Дальше нужен повторный вход, даже если сессией пользовались. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Реже, чем `last_seen_at` обновляется, — иначе каждый запрос превращается
 * в запись в базу ради поля, точность которого никому не нужна до минуты.
 */
export const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

export interface IssuedToken {
  /** Отдаётся клиенту один раз и больше нигде не хранится. */
  readonly token: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/**
 * Выдаёт токен со сроком.
 *
 * Тем же способом выдаются и одноразовые ссылки из писем ([ADR-0029](../../../../../docs/adr/0029-pochta.md)):
 * у них другой срок, но то же свойство — в базе лежит только хеш, сам токен существует
 * ровно один раз, у получателя.
 */
export function issueToken(now: Date = new Date(), ttlMs: number = SESSION_TTL_MS): IssuedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + ttlMs),
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Разбирает заголовок `Authorization: Bearer <token>`.
 * Возвращает `undefined` на всём, что не подходит, — включая пустой токен.
 */
export function readBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer (\S+)$/.exec(header.trim());
  return match?.[1];
}

/**
 * Сравнение хешей за постоянное время.
 *
 * Поиск в базе идёт по индексу и сам по себе утечкой не является, но там, где
 * два секрета сравниваются в коде, обычное `===` завершается на первом различии
 * и по времени сравнения выдаёт совпавший префикс.
 */
export function tokenHashEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
