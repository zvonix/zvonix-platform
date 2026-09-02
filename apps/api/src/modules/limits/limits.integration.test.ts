/**
 * Счётчики по окнам на живом Redis (ADR-0006).
 *
 * Подставным Redis это не проверяется: инкремент со сроком выполняется скриптом Lua
 * внутри сервера, а именно его атомарность здесь и важна — между `INCR` и `EXPIRE`
 * своей реализацией процесс может умереть, и ключ останется без срока навсегда.
 */

import 'reflect-metadata';
import { loadConfig } from '@zvonix/config';
import { createLogger } from '@zvonix/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisService } from '../../infra/redis.js';
import { counterKey, LimitsService, type LimitRule } from './limits.service.js';

const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/15';

process.env['DATABASE_URL'] ??= 'postgresql://zvonix:zvonix@127.0.0.1:5432/zvonix_test';
process.env['SECRET_KEY'] ??= 'x'.repeat(32);
process.env['REDIS_URL'] = TEST_REDIS_URL;

const logger = createLogger({ level: 'error', format: 'json', component: 'проверка' });

let redis: RedisService | undefined;
let limits: LimitsService | undefined;

function service(): LimitsService {
  if (limits === undefined) throw new Error('Счётчики не подняты');
  return limits;
}

const rule: LimitRule = { name: 'проверка', limit: 3, windowSeconds: 60 };

/** Свой адрес у каждой проверки: база Redis общая, и чужой счётчик здесь ни при чём. */
let counter = 0;
const nextSubject = (): string => {
  counter += 1;
  return `10.0.0.${String(counter)}`;
};

beforeAll(() => {
  const config = loadConfig();
  redis = new RedisService(config, logger);
  limits = new LimitsService(redis, config, logger);
});

beforeEach(async () => {
  // Ключи проверок живут минуту; удаляются, чтобы повторный прогон не наследовал счёт.
  const keys = await redis?.connection.keys(counterKey(rule.name, '*'));
  if (keys !== undefined && keys.length > 0) await redis?.connection.del(...keys);
});

afterAll(async () => {
  await redis?.onApplicationShutdown();
});

describe('счётчик по окну', () => {
  it('пропускает, пока предел не достигнут', async () => {
    const subject = nextSubject();

    for (let attempt = 1; attempt <= rule.limit; attempt += 1) {
      const verdict = await service().hit(rule, subject);
      expect(verdict.allowed, `попытка ${String(attempt)}`).toBe(true);
      expect(verdict.current).toBe(attempt);
    }
  });

  it('отказывает на попытке сверх предела', async () => {
    const subject = nextSubject();
    for (let attempt = 0; attempt < rule.limit; attempt += 1) await service().hit(rule, subject);

    const verdict = await service().hit(rule, subject);
    expect(verdict.allowed).toBe(false);
    expect(verdict.current).toBe(rule.limit + 1);
  });

  it('называет срок ожидания: без него клиенту остаётся долбить наугад', async () => {
    const subject = nextSubject();
    for (let attempt = 0; attempt <= rule.limit; attempt += 1) await service().hit(rule, subject);

    const verdict = await service().hit(rule, subject);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(rule.windowSeconds);
  });

  it('ставит ключу срок: иначе адрес блокируется навсегда', async () => {
    const subject = nextSubject();
    await service().hit(rule, subject);

    const ttl = await redis?.connection.pttl(counterKey(rule.name, subject));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(rule.windowSeconds * 1000);
  });

  it('считает адреса по отдельности', async () => {
    const one = nextSubject();
    const other = nextSubject();
    for (let attempt = 0; attempt <= rule.limit; attempt += 1) await service().hit(rule, one);

    expect((await service().hit(rule, one)).allowed).toBe(false);
    expect((await service().hit(rule, other)).allowed).toBe(true);
  });

  it('читает счёт, не засчитывая обращения', async () => {
    const subject = nextSubject();
    await service().hit(rule, subject);

    const first = await service().check(rule, subject);
    const second = await service().check(rule, subject);
    expect(first.current).toBe(1);
    expect(second.current).toBe(1);
  });

  it('на пустом счёте пропускает', async () => {
    const verdict = await service().check(rule, nextSubject());
    expect(verdict.allowed).toBe(true);
    expect(verdict.current).toBe(0);
  });

  it('снимает счёт: удачная попытка прощает накопленные неудачи', async () => {
    const subject = nextSubject();
    for (let attempt = 0; attempt <= rule.limit; attempt += 1) await service().hit(rule, subject);
    expect((await service().check(rule, subject)).allowed).toBe(false);

    await service().reset(rule, subject);

    expect((await service().check(rule, subject)).allowed).toBe(true);
  });
});

describe('недоступный Redis', () => {
  it('пропускает и не роняет запрос', async () => {
    // Довод целиком — в `limits.service.ts`: блокировка учётной записи остаётся,
    // а отказ здесь закрыл бы вход всем, включая того, кому чинить Redis.
    const config = { ...loadConfig(), REDIS_URL: 'redis://127.0.0.1:1/0' };
    const unreachable = new RedisService(config, logger);
    const isolated = new LimitsService(unreachable, config, logger);

    try {
      const verdict = await isolated.hit(rule, nextSubject());
      expect(verdict.allowed).toBe(true);
    } finally {
      await unreachable.onApplicationShutdown();
    }
  }, 20_000);
});
