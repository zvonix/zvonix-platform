/**
 * Прогрев и рекомендованная работа номера (ADR-0105).
 *
 * На реальной базе: попытки считаются по таблице вызовов, и предел пересчитывается в той же транзакции, что
 * занимает номер. Фон остальных наборов — без предела (`resetDatabase`), здесь он включается настройками.
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
let nodeId = '';
let nodeKey = '';

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
  return `79${String(600000000 + msisdnCounter).slice(0, 9)}`;
};

async function post(url: string, payload: Record<string, unknown>, headers = auth()) {
  return api().inject({ method: 'POST', url, headers, payload });
}

async function get(url: string) {
  return api().inject({ method: 'GET', url, headers: auth() });
}

async function createUser(role: 'client' | 'partner' | 'support'): Promise<string> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const created = await api().get(IdentityService).createByAdmin({
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    fullName: 'Владелец',
    role,
    status: 'active',
  });
  return created.id;
}

interface Partner {
  readonly id: string;
  readonly simId: string;
}

/** Подтверждённый партнёр со шлюзом, портом, активной SIM и ценой. */
async function createPartner(operatorId: string, concurrency = 4): Promise<Partner> {
  const partner = (
    await post('/partners', {
      ownerUserId: await createUser('partner'),
      name: 'Иванов Иван',
      displayName: unique('Партнёр'),
    })
  ).json<{ partner: { id: string } }>().partner.id;

  await withDatabase(async (execute) => {
    await execute(sql`update partners set status = 'verified' where id = ${partner}`);
  });

  const gateway = (
    await post('/gateways', { partnerId: partner, name: unique('Шлюз'), type: 'goip' })
  ).json<{ gateway: { id: string } }>().gateway.id;
  await post(`/gateways/${gateway}/status`, { status: 'active' });
  // Маршрутизация выбирает только шлюзы, зарегистрированные на принявшем вызов узле.
  await registerGateway(api(), nodeKey, gateway);

  const port = (await post(`/gateways/${gateway}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;

  const sim = (
    await post('/sim-cards', { partnerId: partner, operatorId, msisdn: nextMsisdn() })
  ).json<{ sim: { id: string } }>().sim.id;
  await post(`/sim-cards/${sim}/status`, { status: 'active' });
  // Одновременность не должна подменять собой лимит: иначе проверялась бы занятость SIM.
  await post(`/sim-cards/${sim}/concurrency`, { maxConcurrentCalls: concurrency });
  await post(`/gateway-ports/${port}/sim`, { simCardId: sim });

  await post('/partner-rates', {
    partnerId: partner,
    operatorId,
    pricePerMinute: '1',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });

  return { id: partner, simId: sim };
}

interface Scenario {
  readonly operator: string;
  readonly client: string;
  readonly channel: string;
  readonly destination: string;
}

async function scenario(): Promise<Scenario> {
  const operator = (await post('/operators', { name: unique('Оператор') })).json<{
    operator: { id: string };
  }>().operator.id;

  const client = (
    await post('/clients', { ownerUserId: await createUser('client'), name: unique('Такси') })
  ).json<{ client: { id: string } }>().client.id;
  await withDatabase(async (execute) => {
    await execute(sql`update clients set status = 'active' where id = ${client}`);
  });

  const channel = (
    await post('/channels', { clientId: client, name: unique('Линия'), recordingRequired: false })
  ).json<{ channel: { id: string } }>().channel.id;
  await post(`/channels/${channel}/status`, { status: 'active' });

  await post('/commission-rules', {
    clientId: client,
    percentBasisPoints: 0,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  await post(`/clients/${client}/deposit`, {
    amount: '100000',
    idempotencyKey: unique('deposit'),
    description: 'Пополнение под проверку',
  });

  const destination = nextMsisdn();
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into number_resolutions (id, msisdn, operator_id, source, resolved_at, expires_at)
      values (gen_random_uuid()::text::uuid, ${destination}, ${operator}, 'manual', now(), now() + interval '30 days')
    `);
  });

  return { operator, client, channel, destination };
}

interface Preview {
  outcome: string;
  reason: string | null;
  sip_response: string | null;
  candidates: { sim_card_id: string }[];
}

async function route(channel: string, destination: string, callId = unique('call')) {
  const response = await post('/routing/preview', {
    callId,
    channelId: channel,
    nodeId,
    destination,
  });
  expect(response.statusCode).toBe(201);
  return { ...response.json<Preview>(), callId };
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
}, 180_000);

afterAll(async () => {
  await app?.close();
});

async function settings(values: Record<string, unknown>) {
  const response = await api().inject({
    method: 'PUT',
    url: '/settings',
    headers: auth(),
    payload: { settings: values },
  });
  expect(response.statusCode).toBe(200);
}

interface SimPace {
  warmup_day: number | null;
  per_hour: number | null;
  per_day: number | null;
  used_hour: number;
  used_day: number;
}

async function paceOf(partnerId: string, simId: string): Promise<SimPace | undefined> {
  const response = await get(`/sim-cards?partnerId=${partnerId}`);
  expect(response.statusCode).toBe(200);
  return response
    .json<{ sim_cards: { id: string; pace?: SimPace }[] }>()
    .sim_cards.find((sim) => sim.id === simId)?.pace;
}

async function warmupStartedAt(simId: string): Promise<unknown> {
  return withDatabase(async (execute) => {
    const result = await execute(sql`select warmup_started_at from sim_cards where id = ${simId}`);
    return (result.rows[0] as { warmup_started_at: unknown } | undefined)?.warmup_started_at;
  });
}

/** Попытки «в прошлом»: номер звонил, но давно — проверка молчания и прогретости. */
async function pastCall(channel: string, simId: string, startedAt: string) {
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into calls (id, external_id, channel_id, node_id, operator_id, destination, sim_card_id, gateway_id,
                         status, started_at)
      select gen_random_uuid(), ${unique('old')}, ${channel}, ${nodeId}, s.operator_id, '79000000000', s.id,
             p.gateway_id, 'completed', ${startedAt}::timestamptz
        from sim_cards s join gateway_ports p on p.sim_card_id = s.id
       where s.id = ${simId}
    `);
  });
}

describe('прогрев и рекомендованная работа номера (ADR-0105)', () => {
  it('новый номер: два вызова в час, третий уходит на соседа, отсчёт прогрева ставит первый вызов', async () => {
    await settings({
      'calls.warmup_enabled': true,
      'calls.recommended_per_hour': 20,
      'calls.recommended_per_day': 150,
    });
    const { operator, channel, destination } = await scenario();
    const fresh = await createPartner(operator);

    expect(await warmupStartedAt(fresh.simId)).toBeNull();
    const first = await route(channel, destination);
    expect(first.outcome).toBe('routed');
    expect(first.candidates[0]?.sim_card_id).toBe(fresh.simId);
    expect(await warmupStartedAt(fresh.simId)).not.toBeNull();
    expect((await route(channel, destination)).outcome).toBe('routed');

    // Единственный номер исчерпал час — отказ называется лимитом, а не «нет SIM».
    const third = await route(channel, destination);
    expect(third.outcome).toBe('rejected');
    expect(third.reason).toBe('limit_exceeded');

    const pace = await paceOf(fresh.id, fresh.simId);
    expect(pace).toEqual({ warmup_day: 1, per_hour: 2, per_day: 10, used_hour: 2, used_day: 2 });

    // Появился сосед — вызов уходит к нему, а не отказывается.
    const neighbour = await createPartner(operator);
    const fourth = await route(channel, destination);
    expect(fourth.outcome).toBe('routed');
    expect(fourth.candidates[0]?.sim_card_id).toBe(neighbour.simId);
  });

  it('звонивший номер без отметки прогрет: действует рекомендованное «в час»', async () => {
    await settings({
      'calls.warmup_enabled': true,
      'calls.recommended_per_hour': 3,
      'calls.recommended_per_day': 150,
    });
    const { operator, channel, destination } = await scenario();
    const warmed = await createPartner(operator);
    await pastCall(channel, warmed.simId, new Date(Date.now() - 2 * 86_400_000).toISOString());

    for (let index = 0; index < 3; index += 1) {
      expect((await route(channel, destination)).outcome).toBe('routed');
    }
    expect((await route(channel, destination)).reason).toBe('limit_exceeded');
    expect(await paceOf(warmed.id, warmed.simId)).toMatchObject({
      warmup_day: null,
      per_hour: 3,
      used_hour: 3,
    });
    expect(await warmupStartedAt(warmed.simId)).toBeNull();
  });

  it('молчавший 14 суток номер прогревается заново', async () => {
    await settings({
      'calls.warmup_enabled': true,
      'calls.recommended_per_hour': 20,
      'calls.recommended_per_day': 150,
    });
    const { operator, channel, destination } = await scenario();
    const idle = await createPartner(operator);
    await pastCall(channel, idle.simId, new Date(Date.now() - 20 * 86_400_000).toISOString());

    expect(await paceOf(idle.id, idle.simId)).toMatchObject({ warmup_day: 1, per_hour: 2 });
    expect((await route(channel, destination)).outcome).toBe('routed');
    expect(await warmupStartedAt(idle.simId)).not.toBeNull();
  });

  it('выключено и нули — номер без предела', async () => {
    await settings({
      'calls.warmup_enabled': false,
      'calls.recommended_per_hour': 0,
      'calls.recommended_per_day': 0,
    });
    const { operator, channel, destination } = await scenario();
    const free = await createPartner(operator);
    for (let index = 0; index < 4; index += 1) {
      expect((await route(channel, destination)).outcome).toBe('routed');
    }
    expect(await paceOf(free.id, free.simId)).toEqual({
      warmup_day: null,
      per_hour: null,
      per_day: null,
      used_hour: 4,
      used_day: 4,
    });
  });
});
