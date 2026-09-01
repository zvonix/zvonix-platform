import { describe, expect, it } from 'vitest';
import {
  hashToken,
  issueToken,
  readBearer,
  SESSION_TTL_MS,
  tokenHashEquals,
} from './session-token.js';

describe('токены сессий', () => {
  it('выдаёт токен, его хеш и срок', () => {
    const now = new Date('2026-09-01T10:00:00.000Z');
    const issued = issueToken(now);

    expect(issued.token).toHaveLength(43); // 32 байта в base64url
    expect(issued.tokenHash).toBe(hashToken(issued.token));
    expect(issued.expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);
  });

  it('не повторяется', () => {
    const issued = new Set(Array.from({ length: 500 }, () => issueToken().token));
    expect(issued.size).toBe(500);
  });

  it('хеш не содержит самого токена', () => {
    // В базу уходит хеш: утечка таблицы не должна давать возможность войти.
    const { token, tokenHash } = issueToken();
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('разбирает заголовок Authorization', () => {
    expect(readBearer('Bearer abc123')).toBe('abc123');
    expect(readBearer('  Bearer abc123  ')).toBe('abc123');
  });

  it('отвергает всё, что не Bearer с непустым токеном', () => {
    expect(readBearer(undefined)).toBeUndefined();
    expect(readBearer('')).toBeUndefined();
    expect(readBearer('Bearer')).toBeUndefined();
    expect(readBearer('Bearer ')).toBeUndefined();
    expect(readBearer('Basic abc123')).toBeUndefined();
    expect(readBearer('bearer abc123')).toBeUndefined();
    expect(readBearer('Bearer abc 123')).toBeUndefined();
  });

  it('сравнивает хеши без утечки по длине совпадения', () => {
    const hash = hashToken('токен');
    expect(tokenHashEquals(hash, hash)).toBe(true);
    expect(tokenHashEquals(hash, hashToken('другой'))).toBe(false);
    expect(tokenHashEquals(hash, hash.slice(0, 10))).toBe(false);
    expect(tokenHashEquals(hash, '')).toBe(false);
  });
});
