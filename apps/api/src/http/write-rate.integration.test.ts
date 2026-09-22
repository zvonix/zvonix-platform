/**
 * Предел частоты изменяющих обращений
 * ([ADR-0041](../../../../docs/adr/0041-predel-chastoty-izmeneniy.md)).
 *
 * Единственный набор, где предел **включён**: в остальных он снят, потому что
 * подготовка проверки — это десятки записей одним администратором за секунды.
 *
 * Проверяется не только «слишком много — отказ», но и три исключения, каждое из которых
 * при ошибке ломает не защиту, а работу: чтения не считаются, машинный контур
 * не считается (иначе узел перестал бы присылать CDR), счёт идёт по учётной записи,
 * а не на всех сразу.
 *
 * И одно исключение из исключения: **клиентский ключ считается**, включая чтения
 * ([ADR-0044](../../../../docs/adr/0044-klientskiy-api.md)). Узел развернули мы,
 * чужую диспетчерскую — нет, и сорвавшийся там цикл опроса остановит только человек.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
} from '../testing/harness.js';

/** Пять в минуту: тот же механизм, что и при ста двадцати, но проверяется за секунду. */
const LIMIT = 5;

prepareEnvironment({
  WRITE_RATE_LIMIT_PER_MINUTE: String(LIMIT),
  CLIENT_API_RATE_LIMIT_PER_MINUTE: String(LIMIT),
});

let app: NestFastifyApplication | undefined;
let admin = '';
let other = '';
let nodeKey = '';
let nodeId = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const as = (token: string) => ({ authorization: `Bearer ${token}` });

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

async function login(email: string): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return response.json<{ token: string }>().token;
}

async function createAdmin(): Promise<string> {
  const { IdentityService } = await import('../modules/identity/identity.service.js');
  const email = uniqueEmail();
  await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Администратор',
    role: 'admin',
    status: 'active',
  });
  return login(email);
}

/** Заведение оператора: изменяющее обращение, доступное администратору и без данных. */
async function write(token: string): Promise<number> {
  const response = await api().inject({
    method: 'POST',
    url: '/operators',
    headers: as(token),
    payload: { name: unique('Оператор') },
  });
  return response.statusCode;
}

async function read(token: string): Promise<number> {
  const response = await api().inject({ method: 'GET', url: '/operators', headers: as(token) });
  return response.statusCode;
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  admin = await createAdmin();
  other = await createAdmin();

  const provisioned = await api().inject({
    method: 'POST',
    url: '/nodes',
    headers: as(other),
    payload: { name: unique('Узел') },
  });
  nodeId = provisioned.json<{ node: { id: string } }>().node.id;
  const command = provisioned.json<{ install: { command: string } }>().install.command;
  const enrolled = await api().inject({
    method: 'POST',
    url: '/node/enroll',
    headers: as(command.slice(command.lastIndexOf(' ') + 1)),
    payload: { hostname: unique('node'), agentVersion: '1.0.0' },
  });
  const key = enrolled.json<{ key: { key_id: string; secret: string } }>().key;
  nodeKey = `${key.key_id}.${key.secret}`;
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('предел изменений', () => {
  it('пропускает столько, сколько разрешено, и отказывает следующему', async () => {
    const token = await createAdmin();

    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      expect(`попытка ${String(attempt)} → ${String(await write(token))}`).toBe(
        `попытка ${String(attempt)} → 201`,
      );
    }

    const refused = await api().inject({
      method: 'POST',
      url: '/operators',
      headers: as(token),
      payload: { name: unique('Оператор') },
    });

    expect(refused.statusCode).toBe(429);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('rate_limited');
    // `Retry-After` — часть протокола, а не украшение: без него вызывающая сторона
    // повторяет вслепую и попадает в тот же отказ.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  }, 60_000);

  it('считает по учётной записи: сосед не наказан за чужой всплеск', async () => {
    const noisy = await createAdmin();
    const quiet = await createAdmin();

    for (let attempt = 0; attempt <= LIMIT; attempt += 1) await write(noisy);
    expect(await write(noisy)).toBe(429);

    expect(await write(quiet)).toBe(201);
  }, 60_000);

  it('чтения не считаются вовсе', async () => {
    const token = await createAdmin();

    // Вдесятеро больше предела: если бы чтения считались, отказ пришёл бы на шестом.
    for (let attempt = 0; attempt < LIMIT * 10; attempt += 1) {
      expect(await read(token)).toBe(200);
    }
    // И после них изменение по-прежнему проходит: счётчик изменений не тронут.
    expect(await write(token)).toBe(201);
  }, 60_000);
});

describe('исключения', () => {
  it('машинный контур не ограничивается: иначе узел перестанет присылать CDR', async () => {
    // Узел спрашивает маршрут на каждый вызов и присылает CDR на каждый разговор —
    // человеческий предел там означал бы несостоявшиеся звонки (ADR-0041).
    for (let attempt = 0; attempt <= LIMIT * 3; attempt += 1) {
      const beat = await api().inject({
        method: 'POST',
        url: '/node/heartbeat',
        headers: as(nodeKey),
        payload: { nodeId, activeCalls: 0 },
      });
      expect(`удар ${String(attempt)} → ${String(beat.statusCode)}`).toBe(
        `удар ${String(attempt)} → 200`,
      );
    }
  }, 60_000);

  it('клиентский ключ считается, и чтения тоже: опрос и есть его нагрузка', async () => {
    const { IdentityService } = await import('../modules/identity/identity.service.js');
    const email = uniqueEmail();
    const owner = await api().get(IdentityService).createByAdmin({
      email,
      password: TEST_PASSWORD,
      fullName: 'Диспетчер',
      role: 'client',
      status: 'active',
    });
    const ownerToken = await login(email);

    const clientId = (
      await api().inject({
        method: 'POST',
        url: '/clients',
        headers: as(admin),
        payload: { ownerUserId: owner.id, name: unique('Такси') },
      })
    ).json<{ client: { id: string } }>().client.id;
    await api().inject({
      method: 'PATCH',
      url: `/clients/${clientId}/status`,
      headers: as(other),
      payload: { status: 'active' },
    });

    const key = (
      await api().inject({
        method: 'POST',
        url: '/client/api-keys',
        headers: as(ownerToken),
        payload: { label: 'Диспетчерская', allowedIps: [] },
      })
    ).json<{ key: { key_id: string; secret: string } }>().key;

    const basic = {
      authorization: `Basic ${Buffer.from(`${key.key_id}:${key.secret}`, 'utf8').toString('base64')}`,
    };

    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      const answer = await api().inject({ method: 'GET', url: '/v1/balance', headers: basic });
      expect(`опрос ${String(attempt)} -> ${String(answer.statusCode)}`).toBe(
        `опрос ${String(attempt)} -> 200`,
      );
    }

    const refused = await api().inject({ method: 'GET', url: '/v1/balance', headers: basic });
    expect(refused.statusCode).toBe(429);
    // Ключ назван в отказе: у клиента их несколько, и разбирать он будет тот,
    // который сорвался, а не все сразу.
    expect(refused.json<{ error: { details: { key_id: string } } }>().error.details.key_id).toBe(
      key.key_id,
    );
  }, 60_000);

  it('вход не считается этим счётчиком: у него своя угроза и свой предел', async () => {
    const { IdentityService } = await import('../modules/identity/identity.service.js');
    const email = uniqueEmail();
    await api().get(IdentityService).createByAdmin({
      email,
      password: TEST_PASSWORD,
      fullName: 'Кто-то',
      role: 'admin',
      status: 'active',
    });

    for (let attempt = 0; attempt <= LIMIT * 2; attempt += 1) {
      const response = await api().inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: TEST_PASSWORD },
      });
      expect(`вход ${String(attempt)} → ${String(response.statusCode)}`).toBe(
        `вход ${String(attempt)} → 200`,
      );
    }
  }, 60_000);

  it('выход работает и при исчерпанном счётчике', async () => {
    // Дверь наружу не запирается пределом объёма: человек, чью сессию захватили,
    // обязан суметь её оборвать — а счётчик у него в этот момент исчерпан чужими
    // руками (ADR-0041).
    const token = await createAdmin();
    for (let attempt = 0; attempt <= LIMIT; attempt += 1) await write(token);
    expect(await write(token)).toBe(429);

    const left = await api().inject({ method: 'POST', url: '/auth/logout', headers: as(token) });
    expect(left.statusCode).toBe(204);
  }, 60_000);

  it('свежая учётная запись начинает с чистого счётчика', async () => {
    expect(await write(await createAdmin())).toBe(201);
    expect(admin).not.toBe('');
  }, 60_000);
});
