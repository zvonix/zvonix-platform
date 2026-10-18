import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../infra/tokens.js';
import type { RedisService } from '../../infra/redis.js';
import type { MailService } from '../mail/mail.service.js';
import type { MessagesService } from '../messaging/messages.service.js';
import { PlatformHealthService, WORKER_HEARTBEAT_KEY } from './platform-health.service.js';

const NOW = new Date('2026-10-18T12:00:00Z');
const minutesAgo = (minutes: number): string =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const logger = (): Logger => {
  const stub = { child: () => stub, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return stub;
};

interface Setup {
  redisReady?: boolean;
  heartbeat?: string | null;
  oldestPending?: string | null;
  configured?: boolean;
  lastError?: string | null;
  messages?: { total: number; failed: number };
  mailFails?: boolean;
}

function build(setup: Setup = {}) {
  const set = vi.fn();
  const redis = {
    connection: {
      status: setup.redisReady === false ? 'end' : 'ready',
      get: vi.fn((key: string) =>
        Promise.resolve(key === WORKER_HEARTBEAT_KEY ? (setup.heartbeat ?? minutesAgo(0)) : null),
      ),
      set,
    },
  } as unknown as RedisService;
  const mail = {
    queueOverview: () =>
      setup.mailFails === true
        ? Promise.reject(new Error('база недоступна'))
        : Promise.resolve({
            configured: setup.configured ?? true,
            pending: setup.oldestPending === undefined || setup.oldestPending === null ? 0 : 3,
            failed: 0,
            sent: 0,
            oldest_pending_at: setup.oldestPending ?? null,
            recent: [{ last_error: setup.lastError ?? null }],
          }),
  } as unknown as MailService;
  const messages = {
    health: () => Promise.resolve(setup.messages ?? { total: 0, failed: 0 }),
  } as unknown as MessagesService;
  return { service: new PlatformHealthService(redis, mail, messages, logger()), set };
}

describe('поломки площадки', () => {
  it('всё в порядке — пусто', async () => {
    expect(await build().service.problems(NOW)).toEqual([]);
  });

  it('воркер не отмечался больше трёх минут или не отмечался вовсе', async () => {
    const stale = await build({ heartbeat: minutesAgo(4) }).service.problems(NOW);
    expect(stale.map((p) => p.name)).toEqual(['Фоновый воркер']);
    const never = await build({ heartbeat: 'ещё не было' }).service.problems(NOW);
    expect(never.map((p) => p.name)).toEqual(['Фоновый воркер']);
    expect(await build({ heartbeat: minutesAgo(2) }).service.problems(NOW)).toEqual([]);
  });

  it('Redis недоступен — это и есть сообщение', async () => {
    const problems = await build({ redisReady: false }).service.problems(NOW);
    expect(problems.map((p) => p.name)).toEqual(['Redis']);
  });

  it('письмо ждёт дольше десяти минут — почта сломана, с текстом последней ошибки', async () => {
    const problems = await build({
      oldestPending: minutesAgo(11),
      lastError: 'Invalid login: 535',
    }).service.problems(NOW);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.name).toBe('Почта');
    expect(problems[0]?.reason).toContain('Invalid login: 535');
    expect(await build({ oldestPending: minutesAgo(5) }).service.problems(NOW)).toEqual([]);
  });

  it('почта не настроена, а письма копятся — об этом и сказано', async () => {
    const problems = await build({
      oldestPending: minutesAgo(30),
      configured: false,
    }).service.problems(NOW);
    expect(problems[0]?.reason).toContain('не настроена');
  });

  it('больше половины сообщений за час не отправлено — сбой отправки; мало сообщений — не повод', async () => {
    const sick = await build({ messages: { total: 12, failed: 7 } }).service.problems(NOW);
    expect(sick.map((p) => p.name)).toEqual(['Сообщения MAX']);
    expect(await build({ messages: { total: 4, failed: 4 } }).service.problems(NOW)).toEqual([]);
    expect(await build({ messages: { total: 20, failed: 5 } }).service.problems(NOW)).toEqual([]);
  });

  it('сбой чтения одного источника не гасит остальные', async () => {
    const problems = await build({
      mailFails: true,
      heartbeat: minutesAgo(10),
    }).service.problems(NOW);
    expect(problems.map((p) => p.name)).toEqual(['Фоновый воркер']);
  });

  it('отметка воркера пишется в Redis', async () => {
    const { service, set } = build();
    expect(await service.recordWorkerHeartbeat(NOW)).toBe(1);
    expect(set).toHaveBeenCalledWith(WORKER_HEARTBEAT_KEY, NOW.toISOString());
  });
});
