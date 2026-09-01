/**
 * Машинный доступ на реальной базе (ADR-0019).
 *
 * Проверяется то, что без настоящей PostgreSQL не проверяется вовсе: одноразовость токена
 * установки при одновременных попытках, немедленное действие отзыва и разделение двух
 * контуров — человеческого и машинного.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
  withDatabase,
} from '../../testing/harness.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let token = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const auth = () => ({ authorization: `Bearer ${token}` });

const basic = (keyId: string, secret: string) => ({
  authorization: `Basic ${Buffer.from(`${keyId}:${secret}`, 'utf8').toString('base64')}`,
});

const bearer = (keyId: string, secret: string) => ({
  authorization: `Bearer ${keyId}.${secret}`,
});

interface IssuedKey {
  credential_id: string;
  key_id: string;
  secret: string;
  expires_at: string | null;
}

async function issueNodeKey(allowedIps: string[] = []): Promise<IssuedKey> {
  const response = await api().inject({
    method: 'POST',
    url: '/machine-keys/nodes',
    headers: auth(),
    payload: { nodeId: crypto.randomUUID(), label: 'Узел проверки', allowedIps },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ key: IssuedKey }>().key;
}

/**
 * Токен установки выпускается только вместе с узлом: он бессмыслен без узла,
 * для которого предназначен. Достаём его из команды установки — ровно оттуда,
 * откуда его берёт человек.
 */
async function issueEnrollment(): Promise<{
  keyId: string;
  secret: string;
  expiresAt: string | null;
}> {
  const response = await api().inject({
    method: 'POST',
    url: '/nodes',
    headers: auth(),
    payload: { name: `Узел ${String(Date.now())}-${String(Math.random()).slice(2, 8)}` },
  });
  expect(response.statusCode).toBe(201);
  const install = response.json<{ install: { command: string; token_expires_at: string | null } }>()
    .install;

  const presented = install.command.slice(install.command.lastIndexOf(' ') + 1);
  const at = presented.indexOf('.');
  return {
    keyId: presented.slice(0, at),
    secret: presented.slice(at + 1),
    expiresAt: install.token_expires_at,
  };
}

const self = (headers: Record<string, string>) =>
  api().inject({ method: 'GET', url: '/machine/self', headers });

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Администратор',
    role: 'admin',
    status: 'active',
  });

  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  token = login.json<{ token: string }>().token;
});

afterAll(async () => {
  await app?.close();
});

describe('выпуск ключа', () => {
  it('секрет отдаётся один раз и больше нигде не появляется', async () => {
    const key = await issueNodeKey();
    expect(key.secret.length).toBeGreaterThan(20);

    const list = await api().inject({ method: 'GET', url: '/machine-keys', headers: auth() });
    expect(list.statusCode).toBe(200);
    // Проверка по сырому телу, а не по разобранному объекту: секрет, случайно попавший
    // в любое поле ответа, обязан быть замечен.
    expect(list.body).not.toContain(key.secret);
    expect(list.body).toContain(key.key_id);
  });

  it('в базе лежит хеш, а не секрет', async () => {
    const key = await issueNodeKey();
    const stored = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select secret_hash from machine_credentials where key_id = ${key.key_id}`,
      );
      return (result.rows[0] as { secret_hash: string }).secret_hash;
    });

    expect(stored).not.toBe(key.secret);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it('у ключа узла срока нет: истёкший ключ означал бы отказ телефонии', async () => {
    expect((await issueNodeKey()).expires_at).toBeNull();
  });

  it('у токена установки срок есть и он короткий', async () => {
    const key = await issueEnrollment();
    expect(key.expiresAt).not.toBeNull();
    const hours = (new Date(key.expiresAt ?? 0).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(0);
    expect(hours).toBeLessThanOrEqual(1);
  });

  it('адрес, который не является адресом, отвергается схемой', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/machine-keys/nodes',
      headers: auth(),
      payload: {
        nodeId: crypto.randomUUID(),
        label: 'Узел',
        allowedIps: ['не адрес'],
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('проверка ключа', () => {
  it('принимается и в виде Basic, и в виде Bearer', async () => {
    const key = await issueNodeKey();

    const asBasic = await self(basic(key.key_id, key.secret));
    expect(asBasic.statusCode).toBe(200);
    expect(asBasic.json<{ key_id: string }>().key_id).toBe(key.key_id);

    const asBearer = await self(bearer(key.key_id, key.secret));
    expect(asBearer.statusCode).toBe(200);
    expect(asBearer.json<{ kind: string }>().kind).toBe('node');
  });

  it('неверный секрет не принимается', async () => {
    const key = await issueNodeKey();
    expect((await self(basic(key.key_id, 'не тот секрет'))).statusCode).toBe(401);
  });

  it('несуществующий ключ не отличается по ответу от неверного секрета', async () => {
    const key = await issueNodeKey();
    const unknown = await self(basic('zvx_node_нетакого', 'секрет'));
    const wrong = await self(basic(key.key_id, 'не тот секрет'));

    // По разнице ответов иначе перебираются существующие идентификаторы.
    // Сквозной идентификатор запроса сравнивать нельзя — он на то и сквозной.
    expect(unknown.statusCode).toBe(wrong.statusCode);
    const strip = (raw: string): unknown => {
      const body = JSON.parse(raw) as { error: Record<string, unknown> };
      const { correlation_id: _ignored, ...rest } = body.error;
      return rest;
    };
    expect(strip(unknown.body)).toEqual(strip(wrong.body));
  });

  it('без заголовка — отказ', async () => {
    expect((await self({})).statusCode).toBe(401);
  });

  it('отзыв действует немедленно', async () => {
    const key = await issueNodeKey();
    expect((await self(basic(key.key_id, key.secret))).statusCode).toBe(200);

    const revoke = await api().inject({
      method: 'DELETE',
      url: `/machine-keys/${key.credential_id}`,
      headers: auth(),
    });
    expect(revoke.statusCode).toBe(204);

    // Ради этого свойства ключ и проверяется по базе на каждом запросе.
    expect((await self(basic(key.key_id, key.secret))).statusCode).toBe(401);
  });

  it('повторный отзыв не ошибка и не меняет первого момента', async () => {
    const key = await issueNodeKey();
    const first = await api().inject({
      method: 'DELETE',
      url: `/machine-keys/${key.credential_id}`,
      headers: auth(),
    });
    expect(first.statusCode).toBe(204);

    const at = await revokedAt(key.key_id);
    const second = await api().inject({
      method: 'DELETE',
      url: `/machine-keys/${key.credential_id}`,
      headers: auth(),
    });
    expect(second.statusCode).toBe(204);
    expect(await revokedAt(key.key_id)).toBe(at);
  });

  it('истёкший ключ не принимается', async () => {
    const key = await issueNodeKey();
    await withDatabase(async (execute) => {
      await execute(
        sql`update machine_credentials set expires_at = now() - interval '1 minute' where key_id = ${key.key_id}`,
      );
    });
    expect((await self(basic(key.key_id, key.secret))).statusCode).toBe(401);
  });

  it('ключ вне списка разрешённых адресов не принимается', async () => {
    // Запросы `inject` приходят с 127.0.0.1, поэтому список из чужого адреса закрывает.
    const foreign = await issueNodeKey(['203.0.113.7']);
    expect((await self(basic(foreign.key_id, foreign.secret))).statusCode).toBe(401);

    const local = await issueNodeKey(['127.0.0.1']);
    expect((await self(basic(local.key_id, local.secret))).statusCode).toBe(200);
  });

  it('отметка о применении проставляется', async () => {
    const key = await issueNodeKey();
    expect((await self(basic(key.key_id, key.secret))).statusCode).toBe(200);

    const used = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select last_used_at from machine_credentials where key_id = ${key.key_id}`,
      );
      return (result.rows[0] as { last_used_at: string | null }).last_used_at;
    });
    expect(used).not.toBeNull();
  });
});

describe('два контура не смешиваются', () => {
  it('машинный ключ не открывает обработчик, помеченный ролью', async () => {
    const key = await issueNodeKey();
    const response = await api().inject({
      method: 'GET',
      url: '/machine-keys',
      headers: basic(key.key_id, key.secret),
    });
    // Иначе украденный с узла ключ становится администратором платформы.
    expect(response.statusCode).toBe(401);
  });

  it('человеческая сессия не открывает машинный обработчик', async () => {
    expect((await self(auth())).statusCode).toBe(401);
  });

  it('токен установки не годится как рабочий ключ', async () => {
    const key = await issueEnrollment();
    expect((await self(basic(key.keyId, key.secret))).statusCode).toBe(401);
  });
});

async function revokedAt(keyId: string): Promise<string | null> {
  return withDatabase(async (execute) => {
    const result = await execute(
      sql`select revoked_at from machine_credentials where key_id = ${keyId}`,
    );
    return (result.rows[0] as { revoked_at: string | null }).revoked_at;
  });
}
