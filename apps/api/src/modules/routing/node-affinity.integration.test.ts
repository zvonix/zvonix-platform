/**
 * Вызов уходит только на железо **своего** узла.
 *
 * Диалплан набирает шлюз как зарегистрированного пользователя (`user/gw-…@realm`),
 * а регистрации живут на том узле, куда шлюз пришёл. Кандидат с чужого узла — маршрут,
 * по которому нельзя набрать: узел ответит «нет такого пользователя», деньги при этом
 * уже придержаны, а причина видна только в логе FreeSWITCH.
 *
 * Горизонтальное добавление узлов — заявленная цель архитектуры
 * ([ARCHITECTURE.md](../../../../../docs/ARCHITECTURE.md)), и перерегистрация шлюза
 * на соседний узел — штатный способ пережить отказ. Значит расхождение между «где
 * зарегистрирован» и «куда маршрутизируем» не редкость, а обычный режим.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  registerGateway,
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

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

let msisdnCounter = 0;
const nextMsisdn = (): string => {
  msisdnCounter += 1;
  return `7970${String(1000000 + msisdnCounter)}`;
};

async function post(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url, headers: auth(), payload });
}

async function patch(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'PATCH', url, headers: auth(), payload });
}

/** Узел вместе с рабочим ключом: без ключа нечем отметить регистрацию шлюза. */
async function createNode(): Promise<{ id: string; key: string }> {
  const provisioned = await post('/nodes', { name: unique('Узел') });
  const id = provisioned.json<{ node: { id: string } }>().node.id;
  const command = provisioned.json<{ install: { command: string } }>().install.command;

  const enrolled = await api().inject({
    method: 'POST',
    url: '/node/enroll',
    headers: { authorization: `Bearer ${command.slice(command.lastIndexOf(' ') + 1)}` },
    payload: { hostname: unique('node'), agentVersion: '1.0.0' },
  });
  const key = enrolled.json<{ key: { key_id: string; secret: string } }>().key;

  return { id, key: `${key.key_id}.${key.secret}` };
}

let first: { id: string; key: string };
let second: { id: string; key: string };
let gatewayId = '';
let channelId = '';
let destination = '';

/** Просит маршрут у названного узла и отвечает исходом либо причиной отказа. */
async function routeAt(node: string): Promise<string> {
  const response = await post('/routing/preview', {
    callId: unique('uuid'),
    channelId,
    nodeId: node,
    destination,
  });
  const decision = response.json<{ outcome: string; reason: string | null }>();
  return decision.outcome === 'routed' ? 'routed' : `отказ:${decision.reason ?? '—'}`;
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

  first = await createNode();
  second = await createNode();

  const operatorId = (await post('/operators', { name: unique('Оператор') })).json<{
    operator: { id: string };
  }>().operator.id;

  const partnerOwner = await api().get(IdentityService).createByAdmin({
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    fullName: 'Владелец',
    role: 'partner',
    status: 'active',
  });
  const partnerId = (
    await post('/partners', {
      ownerUserId: partnerOwner.id,
      name: unique('Иванов'),
      displayName: unique('Партнёр'),
    })
  ).json<{ partner: { id: string } }>().partner.id;
  await patch(`/partners/${partnerId}/status`, { status: 'verified' });

  gatewayId = (await post('/gateways', { partnerId, name: unique('Шлюз'), type: 'goip' })).json<{
    gateway: { id: string };
  }>().gateway.id;
  await post(`/gateways/${gatewayId}/status`, { status: 'active' });

  const port = (await post(`/gateways/${gatewayId}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;
  const simId = (await post('/sim-cards', { partnerId, operatorId, msisdn: nextMsisdn() })).json<{
    sim: { id: string };
  }>().sim.id;
  await post(`/sim-cards/${simId}/status`, { status: 'active' });
  await post(`/sim-cards/${simId}/concurrency`, { maxConcurrentCalls: 8 });
  await post(`/gateway-ports/${port}/sim`, { simCardId: simId });

  await post('/partner-rates', {
    partnerId,
    operatorId,
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
  const clientId = (
    await post('/clients', { ownerUserId: clientOwner.id, name: unique('Такси') })
  ).json<{ client: { id: string } }>().client.id;
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

describe('шлюз, не зарегистрированный нигде', () => {
  it('в маршрут не попадает, и причина названа честно', async () => {
    // Оборудование заведено и включено, но партнёр его не подключил: регистрации нет.
    // Раньше такой шлюз выбирался, деньги придерживались, а вызов срывался на наборе.
    expect(await routeAt(first.id)).toBe('отказ:gateway_unregistered');
  }, 120_000);

  it('причина отличается от «нет SIM»: это разговор о железе, а не о недостатке карт', async () => {
    expect(await routeAt(first.id)).not.toBe('отказ:no_sim_available');
  }, 120_000);
});

describe('шлюз, зарегистрированный на одном узле', () => {
  it('обслуживает вызовы своего узла', async () => {
    await registerGateway(api(), first.key, gatewayId);
    expect(await routeAt(first.id)).toBe('routed');
  }, 120_000);

  it('не обслуживает вызовы соседнего: набрать его оттуда нечем', async () => {
    expect(await routeAt(second.id)).toBe('отказ:gateway_unregistered');
  }, 120_000);

  it('перерегистрация переносит его вместе с трафиком', async () => {
    // Штатный способ пережить отказ узла: шлюз приходит на соседний, и вызовы идут там.
    await registerGateway(api(), second.key, gatewayId);
    expect(await routeAt(second.id)).toBe('routed');
    expect(await routeAt(first.id)).toBe('отказ:gateway_unregistered');
  }, 120_000);
});
