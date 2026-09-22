/**
 * Терминация через SIP-транк
 * ([ADR-0039](../../../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
 *
 * Главная проверка — предпоследняя: диалплан для транка набирает **исходящим
 * sofia-gateway**, а не зарегистрированным у нас пользователем. Это то самое отличие,
 * ради которого транк и заводится отдельным видом шлюза: у GOIP регистрация идёт к нам,
 * у провайдера — от нас.
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
let nodeId = '';
let nodeKey = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const auth = () => ({ authorization: `Bearer ${token}` });
const asNode = () => ({ authorization: `Bearer ${nodeKey}` });

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

let msisdnCounter = 0;
const nextMsisdn = (): string => {
  msisdnCounter += 1;
  return `7960${String(1000000 + msisdnCounter)}`;
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

interface Trunk {
  id: string;
  sip_username: string;
  status: string;
  has_secret: boolean;
  proxy_host: string;
  outbound_username: string | null;
  max_concurrent_calls: number;
}

/** Пароль провайдера. Заведомо узнаваемый: его ищут в ответах, где его быть не должно. */
const PROVIDER_SECRET = 'секрет-провайдера-который-нельзя-показывать';

let operatorId = '';
let partnerId = '';
let clientId = '';
let channelId = '';
let trunk: Trunk;
let destination = '';

async function routePreview(callId: string, to: string) {
  return post('/routing/preview', { callId, channelId, nodeId, destination: to });
}

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
  token = (
    await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
    })
  ).json<{ token: string }>().token;

  const provisioned = await post('/nodes', { name: unique('Узел') });
  nodeId = provisioned.json<{ node: { id: string } }>().node.id;
  const command = provisioned.json<{ install: { command: string } }>().install.command;
  const enrolled = await api().inject({
    method: 'POST',
    url: '/node/enroll',
    headers: { authorization: `Bearer ${command.slice(command.lastIndexOf(' ') + 1)}` },
    payload: { hostname: unique('node'), agentVersion: '1.0.0' },
  });
  const key = enrolled.json<{ key: { key_id: string; secret: string } }>().key;
  nodeKey = `${key.key_id}.${key.secret}`;

  operatorId = (await post('/operators', { name: unique('Оператор') })).json<{
    operator: { id: string };
  }>().operator.id;

  const partnerOwner = await api().get(IdentityService).createByAdmin({
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    fullName: 'Владелец',
    role: 'partner',
    status: 'active',
  });
  partnerId = (
    await post('/partners', {
      ownerUserId: partnerOwner.id,
      name: 'Транзит Телеком',
      displayName: unique('Партнёр'),
    })
  ).json<{ partner: { id: string } }>().partner.id;
  await patch(`/partners/${partnerId}/status`, { status: 'verified' });

  // Цена именно у способа `sip`: транк без неё в перебор не попадёт (ADR-0040).
  await post('/partner-rates', {
    partnerId,
    operatorId,
    terminationKind: 'sip',
    pricePerMinute: '2',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });

  const clientOwner = await api().get(IdentityService).createByAdmin({
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    fullName: 'Диспетчер',
    role: 'client',
    status: 'active',
  });
  clientId = (await post('/clients', { ownerUserId: clientOwner.id, name: unique('Такси') })).json<{
    client: { id: string };
  }>().client.id;
  await patch(`/clients/${clientId}/status`, { status: 'active' });
  channelId = (await post('/channels', { clientId, name: unique('Линия') })).json<{
    channel: { id: string };
  }>().channel.id;
  await post(`/channels/${channelId}/status`, { status: 'active' });
  await post('/commission-rules', {
    clientId,
    percentBasisPoints: 1500,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  await post(`/clients/${clientId}/deposit`, {
    amount: '100000',
    idempotencyKey: unique('deposit'),
    description: 'Пополнение под проверку',
  });

  const created = await post('/sip-trunks', {
    partnerId,
    nodeId,
    name: 'Транзит основной',
    proxyHost: 'sip.provider.example:5070',
    registersOutbound: true,
    outboundUsername: 'zvonix-01',
    outboundSecret: PROVIDER_SECRET,
    maxConcurrentCalls: 2,
  });
  expect(created.statusCode).toBe(201);
  trunk = created.json<{ trunk: Trunk }>().trunk;
  await post(`/gateways/${trunk.id}/status`, { status: 'active' });

  destination = nextMsisdn();
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into number_resolutions (id, msisdn, operator_id, source, resolved_at, expires_at)
      values (gen_random_uuid()::text::uuid, ${destination}, ${operatorId}, 'manual', now(), now() + interval '30 days')
    `);
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('заведение транка', () => {
  it('пароль провайдера в ответ не попадает — только признак, что он задан', () => {
    expect(trunk.has_secret).toBe(true);
    expect(JSON.stringify(trunk)).not.toContain(PROVIDER_SECRET);
    expect(trunk.sip_username).toMatch(/^gw-/u);
  }, 120_000);

  it('в списке пароля тоже нет', async () => {
    const response = await get(`/sip-trunks?partnerId=${partnerId}`);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(PROVIDER_SECRET);
    expect(response.json<{ trunks: Trunk[] }>().trunks).toHaveLength(1);
  }, 120_000);

  it('регистрация без имени и пароля отвергается с названной причиной', async () => {
    const response = await post('/sip-trunks', {
      partnerId,
      nodeId,
      name: 'Без учётных данных',
      proxyHost: 'sip.provider.example',
      registersOutbound: true,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('имя и пароль');
  }, 120_000);

  it('доступ по адресу учётных данных не требует', async () => {
    const response = await post('/sip-trunks', {
      partnerId,
      nodeId,
      name: unique('По адресу'),
      proxyHost: 'sip.byip.example',
      registersOutbound: false,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ trunk: Trunk }>().trunk.has_secret).toBe(false);
  }, 120_000);
});

describe('транк и каталог узла', () => {
  it('в каталоге не значится: к нему регистрируемся мы, а не он к нам', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/node/directory',
      headers: { ...asNode(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `section=directory&user=${trunk.sip_username}&action=sip_auth`,
    });
    expect(response.statusCode).toBe(200);
    // Ответ «записи нет»: хеша у транка нет, и впустить по его имени некого.
    expect(response.body).not.toContain('a1-hash');
  }, 120_000);

  it('узел получает его отдельным списком — с расшифрованным паролем', async () => {
    const response = await get('/node/sip-gateways', asNode());
    expect(response.statusCode).toBe(200);

    const gateways = response.json<{
      gateways: {
        name: string;
        proxy_host: string;
        register: boolean;
        username: string | null;
        password: string | null;
      }[];
    }>().gateways;

    const registered = gateways.find((row) => row.name === trunk.sip_username);
    expect(registered?.proxy_host).toBe('sip.provider.example:5070');
    expect(registered?.register).toBe(true);
    expect(registered?.username).toBe('zvonix-01');
    // Единственное место, где пароль покидает базу в открытом виде, — и только узлу.
    expect(registered?.password).toBe(PROVIDER_SECRET);
  }, 120_000);

  it('чужому узлу список не отдаётся', async () => {
    const other = await post('/nodes', { name: unique('Другой узел') });
    const command = other.json<{ install: { command: string } }>().install.command;
    const enrolled = await api().inject({
      method: 'POST',
      url: '/node/enroll',
      headers: { authorization: `Bearer ${command.slice(command.lastIndexOf(' ') + 1)}` },
      payload: { hostname: unique('node'), agentVersion: '1.0.0' },
    });
    const key = enrolled.json<{ key: { key_id: string; secret: string } }>().key;

    const response = await get('/node/sip-gateways', {
      authorization: `Bearer ${key.key_id}.${key.secret}`,
    });
    expect(response.json<{ gateways: unknown[] }>().gateways).toHaveLength(0);
  }, 120_000);

  it('человеку список транков узла недоступен: там пароли провайдеров', async () => {
    expect((await get('/node/sip-gateways')).statusCode).toBe(401);
  }, 120_000);
});

describe('вызов через транк', () => {
  it('уходит на транк, и SIM у такого вызова нет', async () => {
    const response = await routePreview(unique('uuid'), destination);
    const decision = response.json<{
      outcome: string;
      candidates: { gateway_id: string; termination_kind: string; sim_card_id: string | null }[];
    }>();

    expect(decision.outcome).toBe('routed');
    expect(decision.candidates[0]?.gateway_id).toBe(trunk.id);
    expect(decision.candidates[0]?.termination_kind).toBe('sip');
    expect(decision.candidates[0]?.sim_card_id).toBeNull();
  }, 120_000);

  it('диалплан набирает исходящим sofia-gateway, а не зарегистрированным у нас', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/node/dialplan',
      headers: asNode(),
      payload: {
        section: 'dialplan',
        'Unique-ID': unique('uuid'),
        'Caller-Destination-Number': destination,
        variable_zvonix_channel: channelId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`sofia/gateway/${trunk.sip_username}/${destination}`);
    // У GOIP набор идёт через пользователя, и спутать эти две записи нельзя.
    expect(response.body).not.toContain(`user/${trunk.sip_username}`);
  }, 120_000);

  it('ёмкость транка ограничивает: третий вызов при двух каналах не проходит', async () => {
    // Два канала транка уже заняты предыдущими проверками — они остались открытыми.
    const third = await routePreview(unique('uuid'), destination);
    expect(third.json<{ outcome: string; reason: string | null }>().reason).toBe(
      'no_sim_available',
    );
  }, 120_000);
});

describe('правка транка', () => {
  it('смена адреса не стирает пароль', async () => {
    const updated = await patch(`/sip-trunks/${trunk.id}`, {
      proxyHost: 'sip.provider.example:5080',
    });
    expect(updated.statusCode).toBe(200);

    const view = updated.json<{ trunk: Trunk }>().trunk;
    expect(view.proxy_host).toBe('sip.provider.example:5080');
    expect(view.has_secret).toBe(true);

    const gateways = (await get('/node/sip-gateways', asNode())).json<{
      gateways: { name: string; password: string | null }[];
    }>().gateways;
    expect(gateways.find((row) => row.name === trunk.sip_username)?.password).toBe(PROVIDER_SECRET);
  }, 120_000);

  it('пустая правка — отказ, а не тихий успех', async () => {
    expect((await patch(`/sip-trunks/${trunk.id}`, {})).statusCode).toBe(400);
  }, 120_000);

  it('правка журналируется без пароля', async () => {
    const entries = (await get('/audit?action=sip_trunk.updated&limit=5')).json<{
      entries: { after: unknown }[];
    }>().entries;

    expect(entries.length).toBeGreaterThan(0);
    const dump = JSON.stringify(entries);
    expect(dump).not.toContain(PROVIDER_SECRET);
    expect(dump).toContain('has_secret');
  }, 120_000);
});
