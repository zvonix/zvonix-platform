/**
 * Клиентский API на реальной базе ([ADR-0044](../../../../../docs/adr/0044-klientskiy-api.md)).
 *
 * Здесь проверяется не удобство, а **граница**: чем открывается `/v1` и чем не
 * открывается, видно ли в нём чужое, и закрывается ли машинная дверь вместе
 * с клиентом. Ключи клиент заводит себе сам — как партнёр своё оборудование
 * ([ADR-0043](../../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md)).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
} from '../../testing/harness.js';

/** Три ключа: предел проверяется за секунды тем же механизмом, что и десять. */
const KEY_LIMIT = 3;

prepareEnvironment({ CLIENT_API_KEY_LIMIT: String(KEY_LIMIT) });

let app: NestFastifyApplication | undefined;
let token = '';
let nodeId = '';
let nodeKeyId = '';
let nodeSecret = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const auth = () => ({ authorization: `Bearer ${token}` });
const as = (bearer: string) => ({ authorization: `Bearer ${bearer}` });
const byKey = (keyId: string, secret: string) => ({
  authorization: `Basic ${Buffer.from(`${keyId}:${secret}`, 'utf8').toString('base64')}`,
});

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

async function post(url: string, payload: Record<string, unknown>, headers = auth()) {
  return api().inject({ method: 'POST', url, headers, payload });
}

async function patch(url: string, payload: Record<string, unknown>, headers = auth()) {
  return api().inject({ method: 'PATCH', url, headers, payload });
}

async function get(url: string, headers = auth()) {
  return api().inject({ method: 'GET', url, headers });
}

async function remove(url: string, headers: Record<string, string>) {
  return api().inject({ method: 'DELETE', url, headers });
}

async function login(email: string): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return response.json<{ token: string }>().token;
}

interface IssuedKey {
  id: string;
  key_id: string;
  secret: string;
  expires_at: string | null;
}

/** Клиент вместе с учётной записью, каналом, ключом и одним записанным вызовом. */
interface Tenant {
  clientId: string;
  channelId: string;
  token: string;
  key: IssuedKey;
  destination: string;
}

async function createTenant(): Promise<Tenant> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  const owner = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Диспетчер',
    role: 'client',
    status: 'active',
  });
  const ownerToken = await login(email);

  const clientId = (await post('/clients', { ownerUserId: owner.id, name: unique('Такси') })).json<{
    client: { id: string };
  }>().client.id;
  expect((await patch(`/clients/${clientId}/status`, { status: 'active' })).statusCode).toBe(200);

  const channelId = (await post('/channels', { clientId, name: unique('Линия') })).json<{
    channel: { id: string };
  }>().channel.id;
  await post(`/channels/${channelId}/status`, { status: 'active' });

  // Вызов, который не состоялся: отказ тоже записывается вызовом (ADR-0042),
  // и для проверки границы этого довольно — телефония здесь не предмет.
  counter += 1;
  const destination = `7930${String(1000000 + counter)}`;
  await post('/routing/preview', { callId: unique('uuid'), channelId, nodeId, destination });

  const key = (
    await post('/client/api-keys', { label: 'Диспетчерская', allowedIps: [] }, as(ownerToken))
  ).json<{ key: IssuedKey }>().key;

  return { clientId, channelId, token: ownerToken, key, destination };
}

let mine: Tenant;
let neighbour: Tenant;

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
  token = await login(email);

  const provisioned = await post('/nodes', { name: unique('Узел') });
  nodeId = provisioned.json<{ node: { id: string } }>().node.id;
  const command = provisioned.json<{ install: { command: string } }>().install.command;
  const enrolled = await api().inject({
    method: 'POST',
    url: '/node/enroll',
    headers: as(command.slice(command.lastIndexOf(' ') + 1)),
    payload: { hostname: unique('node'), agentVersion: '1.0.0' },
  });
  const nodeKey = enrolled.json<{ key: { key_id: string; secret: string } }>().key;
  nodeKeyId = nodeKey.key_id;
  nodeSecret = nodeKey.secret;

  mine = await createTenant();
  neighbour = await createTenant();
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('ключ клиент заводит сам', () => {
  it('секрет приходит один раз и больше нигде не показывается', async () => {
    const issued = (
      await post('/client/api-keys', { label: 'Вторая система', allowedIps: [] }, as(mine.token))
    ).json<{ key: IssuedKey }>();

    expect(issued.key.key_id).toMatch(/^zvx_client_[a-z0-9]{12}$/u);
    expect(issued.key.secret.length).toBeGreaterThan(20);

    const listed = (await get('/client/api-keys', as(mine.token))).json<{
      keys: { key_id: string; label: string }[];
    }>();
    const found = listed.keys.find((key) => key.key_id === issued.key.key_id);
    expect(found?.label).toBe('Вторая система');
    expect(JSON.stringify(listed)).not.toContain(issued.key.secret);
  });

  it('чужих ключей в списке нет', async () => {
    const listed = (await get('/client/api-keys', as(mine.token))).json<{
      keys: { key_id: string }[];
    }>();
    expect(listed.keys.some((key) => key.key_id === neighbour.key.key_id)).toBe(false);
  });

  it('чужой ключ не отозвать: его для клиента не существует', async () => {
    const refused = await remove(`/client/api-keys/${neighbour.key.id}`, as(mine.token));
    expect(refused.statusCode).toBe(404);
  });

  it('заведение упирается в предел, а отозванное в него не считается', async () => {
    const tenant = await createTenant();
    // Один ключ у него уже есть — доводим до предела.
    for (let index = 1; index < KEY_LIMIT; index += 1) {
      const created = await post(
        '/client/api-keys',
        { label: unique('Ключ'), allowedIps: [] },
        as(tenant.token),
      );
      expect(created.statusCode).toBe(201);
    }

    const refused = await post(
      '/client/api-keys',
      { label: 'Лишний', allowedIps: [] },
      as(tenant.token),
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { details: { limit: number } } }>().error.details.limit).toBe(
      KEY_LIMIT,
    );

    // Ротация «завёл новый, отозвал старый» не должна упираться в предел.
    expect((await remove(`/client/api-keys/${tenant.key.id}`, as(tenant.token))).statusCode).toBe(
      204,
    );
    expect(
      (await post('/client/api-keys', { label: 'Взамен', allowedIps: [] }, as(tenant.token)))
        .statusCode,
    ).toBe(201);
  });
});

describe('чем открывается /v1', () => {
  it('ключом клиента — открывается', async () => {
    const response = await get('/v1/calls', byKey(mine.key.key_id, mine.key.secret));
    expect(response.statusCode).toBe(200);
  });

  it('сессией человека — нет: это машинный контур', async () => {
    expect((await get('/v1/calls', as(mine.token))).statusCode).toBe(401);
  });

  it('без ключа — нет', async () => {
    expect((await api().inject({ method: 'GET', url: '/v1/calls' })).statusCode).toBe(401);
  });

  it('ключом узла — нет: вид ключа проверяется, а не только его действительность', async () => {
    expect((await get('/v1/calls', byKey(nodeKeyId, nodeSecret))).statusCode).toBe(401);
  });

  it('отозванный ключ перестаёт открывать немедленно', async () => {
    const tenant = await createTenant();
    expect((await get('/v1/calls', byKey(tenant.key.key_id, tenant.key.secret))).statusCode).toBe(
      200,
    );

    await remove(`/client/api-keys/${tenant.key.id}`, as(tenant.token));

    expect((await get('/v1/calls', byKey(tenant.key.key_id, tenant.key.secret))).statusCode).toBe(
      401,
    );
  });

  it('закрытие клиента закрывает и машинную дверь', async () => {
    const tenant = await createTenant();
    expect((await get('/v1/calls', byKey(tenant.key.key_id, tenant.key.secret))).statusCode).toBe(
      200,
    );

    expect(
      (await patch(`/clients/${tenant.clientId}/status`, { status: 'closed' })).statusCode,
    ).toBe(200);

    expect((await get('/v1/calls', byKey(tenant.key.key_id, tenant.key.secret))).statusCode).toBe(
      401,
    );
  });
});

describe('что отдаёт /v1', () => {
  it('свои вызовы — и ни одного чужого', async () => {
    const answer = (await get('/v1/calls', byKey(mine.key.key_id, mine.key.secret))).json<{
      calls: { id: string; destination: string; channel: { id: string } }[];
      total: number;
    }>();

    expect(answer.total).toBeGreaterThan(0);
    expect(answer.calls.every((call) => call.channel.id === mine.channelId)).toBe(true);
    expect(answer.calls.some((call) => call.destination === neighbour.destination)).toBe(false);
  });

  it('партнёра в ответе нет ни в каком виде (ADR-0014)', async () => {
    const raw = (await get('/v1/calls', byKey(mine.key.key_id, mine.key.secret))).body;
    for (const forbidden of ['partner', 'gateway', 'sim', 'alias']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('один вызов по идентификатору', async () => {
    const listed = (await get('/v1/calls', byKey(mine.key.key_id, mine.key.secret))).json<{
      calls: { id: string }[];
    }>();
    const id = listed.calls[0]?.id ?? '';

    const one = await get(`/v1/calls/${id}`, byKey(mine.key.key_id, mine.key.secret));
    expect(one.statusCode).toBe(200);
    expect(one.json<{ call: { id: string } }>().call.id).toBe(id);
  });

  it('чужой вызов не находится', async () => {
    const listed = (
      await get('/v1/calls', byKey(neighbour.key.key_id, neighbour.key.secret))
    ).json<{
      calls: { id: string }[];
    }>();
    const foreign = listed.calls[0]?.id ?? '';

    const response = await get(`/v1/calls/${foreign}`, byKey(mine.key.key_id, mine.key.secret));
    expect(response.statusCode).toBe(404);
  });

  it('баланс: остаток и доступное вместе — иначе «деньги же есть, почему не звонит»', async () => {
    const response = await get('/v1/balance', byKey(mine.key.key_id, mine.key.secret));
    expect(response.statusCode).toBe(200);

    const answer = response.json<{
      client: { id: string; status: string };
      funds: { balance: string; available: string; held: string; overdraft_limit: string };
    }>();
    expect(answer.client.id).toBe(mine.clientId);
    expect(answer.client.status).toBe('active');
    expect(answer.funds.available.length).toBeGreaterThan(0);
  });
});
