/**
 * Ограничение частоты входа и регистрации по адресу источника.
 *
 * Единственный набор, где `AUTH_RATE_LIMIT_ENABLED` включён: в остальных он выключен,
 * потому что проверки создают десятки учётных записей с одного адреса и упирались бы
 * в предел, задуманный против перебора, а не против них.
 *
 * Проверяется то, чего не видно в проверке самого счётчика: **что именно считается**.
 * У входа — только неудачи, и удачный вход накопленное прощает; у регистрации —
 * все попытки, потому что записи, которую можно было бы заблокировать, ещё нет.
 */

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  uniqueEmail,
  withDatabase,
} from '../../testing/harness.js';

const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/15';

prepareEnvironment({ AUTH_RATE_LIMIT_ENABLED: 'true', REDIS_URL: TEST_REDIS_URL });

const PASSWORD = 'достаточно длинный пароль';

let app: NestFastifyApplication | undefined;

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

/**
 * Свой адрес у каждой проверки.
 *
 * Счётчик ведётся по адресу, и общий на все проверки означал бы, что порядок их запуска
 * меняет исход. `inject` позволяет назвать адрес явно — настоящий запрос принёс бы его
 * в сокете.
 */
let addresses = 0;
/**
 * Своя подсеть у каждого прогона: счётчики живут в Redis дольше одного набора,
 * и второй прогон подряд наследовал бы чужой счёт с тех же адресов.
 */
const RUN = Math.floor(Math.random() * 65536);
const nextAddress = (): string => {
  addresses += 1;
  return `10.${String(Math.floor(RUN / 256))}.${String(RUN % 256)}.${String(addresses)}`;
};

async function login(email: string, password: string, ip: string) {
  return api().inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: ip,
    payload: { email, password },
  });
}

async function register(email: string, ip: string) {
  return api().inject({
    method: 'POST',
    url: '/auth/register',
    remoteAddress: ip,
    payload: { email, password: PASSWORD, fullName: 'Иван Петров', role: 'client' },
  });
}

/** Действующая учётная запись: регистрация оставляет её в `pending`. */
async function activeUser(ip: string): Promise<string> {
  const email = uniqueEmail();
  const created = await register(email, ip);
  expect(created.statusCode).toBe(201);
  await withDatabase(async (execute) => {
    await execute(sql`update users set status = 'active' where email = ${email}`);
  });
  return email;
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
}, 90_000);

afterAll(async () => {
  await app?.close();
});

describe('вход', () => {
  it('не считает удачные попытки: общий адрес конторы не упирается в предел', async () => {
    const ip = nextAddress();
    const email = await activeUser(ip);

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await login(email, PASSWORD, ip);
      expect(response.statusCode, `попытка ${String(attempt)}`).toBe(200);
    }
  }, 60_000);

  it('закрывает адрес после перебора по разным записям', async () => {
    const ip = nextAddress();

    // Каждая попытка — по своей несуществующей записи: блокировка учётной записи
    // такой перебор не ловит, на то и нужен счётчик по адресу.
    let blockedAt = 0;
    for (let attempt = 1; attempt <= 25 && blockedAt === 0; attempt += 1) {
      const response = await login(uniqueEmail(), 'неверный пароль', ip);
      if (response.statusCode === 429) blockedAt = attempt;
      else expect(response.statusCode, `попытка ${String(attempt)}`).toBe(401);
    }

    expect(blockedAt).toBeGreaterThan(0);
  }, 60_000);

  it('называет срок ожидания в ответе', async () => {
    const ip = nextAddress();
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await login(uniqueEmail(), 'неверный пароль', ip);
    }

    const blocked = await login(uniqueEmail(), 'неверный пароль', ip);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ error: { details?: { retry_after_seconds?: number } } }>()).toMatchObject(
      {
        error: { details: { retry_after_seconds: expect.any(Number) as number } },
      },
    );
  }, 60_000);

  it('удачный вход прощает накопленные неудачи', async () => {
    const ip = nextAddress();
    const email = await activeUser(ip);

    for (let attempt = 0; attempt < 15; attempt += 1) {
      await login(uniqueEmail(), 'неверный пароль', ip);
    }
    expect((await login(email, PASSWORD, ip)).statusCode).toBe(200);

    // Счёт снят: следующие пятнадцать неудач снова умещаются в предел.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await login(uniqueEmail(), 'неверный пароль', ip);
      expect(response.statusCode, `попытка ${String(attempt)}`).toBe(401);
    }
  }, 90_000);

  it('считает адреса по отдельности', async () => {
    const blocked = nextAddress();
    const innocent = nextAddress();
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await login(uniqueEmail(), 'неверный пароль', blocked);
    }

    expect((await login(uniqueEmail(), 'неверный пароль', blocked)).statusCode).toBe(429);
    expect((await login(uniqueEmail(), 'неверный пароль', innocent)).statusCode).toBe(401);
  }, 60_000);
});

describe('регистрация', () => {
  it('закрывает адрес, с которого записи заводят потоком', async () => {
    const ip = nextAddress();

    let blockedAt = 0;
    for (let attempt = 1; attempt <= 15 && blockedAt === 0; attempt += 1) {
      const response = await register(uniqueEmail(), ip);
      if (response.statusCode === 429) blockedAt = attempt;
      else expect(response.statusCode, `попытка ${String(attempt)}`).toBe(201);
    }

    // Считаются все попытки, а не неудачные: блокировать здесь нечего — записи,
    // которую можно было бы закрыть, ещё не существует.
    expect(blockedAt).toBeGreaterThan(0);
  }, 90_000);
});
