/**
 * Требования клиента к партнёрам для звонков ([ADR-0095](../../../../../docs/adr/0095-trebovaniya-klienta-k-partnyoram-zvonkov.md))
 * на реальной базе: предел цены по направлению, партнёры, которые слушают записи, способ, причина `requirements_unmet`.
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
const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

let msisdnCounter = 0;
const nextMsisdn = (): string => {
  msisdnCounter += 1;
  return `79${String(500000000 + msisdnCounter).slice(0, 9)}`;
};

const post = (url: string, payload: Record<string, unknown>) =>
  api().inject({ method: 'POST', url, headers: auth(), payload });

async function createUser(): Promise<{ id: string; token: string }> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  const created = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Владелец',
    role: 'member',
    status: 'active',
  });
  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return { id: created.id, token: login.json<{ token: string }>().token };
}

interface Partner {
  readonly id: string;
  readonly ownerToken: string;
  readonly sims: string[];
}

/** Подтверждённый партнёр: один шлюз, `count` портов и по SIM в каждом — одинаковой цены. */
async function createPartner(operatorId: string, count: number, price = '1'): Promise<Partner> {
  const owner = await createUser();
  const partner = (
    await post('/partners', {
      ownerUserId: owner.id,
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
  await registerGateway(api(), nodeKey, gateway);

  const sims: string[] = [];
  for (let number = 1; number <= count; number += 1) {
    const port = (await post(`/gateways/${gateway}/ports`, { portNumber: number })).json<{
      port: { id: string };
    }>().port.id;
    const sim = (
      await post('/sim-cards', { partnerId: partner, operatorId, msisdn: nextMsisdn() })
    ).json<{ sim: { id: string } }>().sim.id;
    await post(`/sim-cards/${sim}/status`, { status: 'active' });
    // Много одновременных вызовов: иначе первый же занимает карту, и порядок проверить нечем.
    await post(`/sim-cards/${sim}/concurrency`, { maxConcurrentCalls: 8 });
    await post(`/gateway-ports/${port}/sim`, { simCardId: sim });
    sims.push(sim);
  }
  await post('/partner-rates', {
    partnerId: partner,
    operatorId,
    pricePerMinute: price,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  return { id: partner, ownerToken: owner.token, sims };
}

async function createChannel(
  operatorId: string,
): Promise<{ channel: string; destination: string; clientToken: string }> {
  const owner = await createUser();
  const client = (await post('/clients', { ownerUserId: owner.id, name: unique('Такси') })).json<{
    client: { id: string };
  }>().client.id;
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
      values (gen_random_uuid()::text::uuid, ${destination}, ${operatorId}, 'manual', now(), now() + interval '30 days')
    `);
  });
  return { channel, destination, clientToken: owner.token };
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
    headers: bearer(command.slice(command.lastIndexOf(' ') + 1)),
    payload: { hostname: unique('node'), agentVersion: '1.0.0' },
  });
  const key = enrolled.json<{ key: { key_id: string; secret: string } }>().key;
  nodeKey = `${key.key_id}.${key.secret}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

const decide = async (
  channel: string,
  destination: string,
): Promise<{ outcome: string; reason: string | null; sims: string[] }> => {
  const response = await post('/routing/preview', {
    callId: unique('call'),
    channelId: channel,
    nodeId,
    destination,
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{
    outcome: string;
    reason: string | null;
    candidates?: { sim_card_id: string }[];
  }>();
  return {
    outcome: body.outcome,
    reason: body.reason,
    sims: (body.candidates ?? []).map((candidate) => candidate.sim_card_id),
  };
};

const setRequirements = (
  clientToken: string,
  payload: {
    terminationKind: string | null;
    noRecordingListeners: boolean;
    maxPrice: string | null;
  },
) =>
  api().inject({
    method: 'PUT',
    url: '/client/call-requirements',
    headers: bearer(clientToken),
    payload,
  });

const operatorId = async (): Promise<string> =>
  (await post('/operators', { name: unique('Оператор') })).json<{ operator: { id: string } }>()
    .operator.id;

const NONE = { terminationKind: null, noRecordingListeners: false, maxPrice: null };

describe('требования клиента к партнёрам для звонков (ADR-0095)', () => {
  it('без требований — прежние значения; сохранение и проверка ввода', async () => {
    const operator = await operatorId();
    const { clientToken } = await createChannel(operator);
    const initial = await api().inject({
      method: 'GET',
      url: '/client/call-requirements',
      headers: bearer(clientToken),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      requirements: { termination_kind: null, no_recording_listeners: false, max_price: null },
    });

    expect((await setRequirements(clientToken, { ...NONE, maxPrice: '0' })).statusCode).toBe(400);
    expect(
      (await setRequirements(clientToken, { ...NONE, terminationKind: 'android' })).statusCode,
    ).toBe(400);
    const saved = await setRequirements(clientToken, {
      terminationKind: 'sim',
      noRecordingListeners: true,
      maxPrice: '2.5',
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      requirements: { termination_kind: 'sim', no_recording_listeners: true, max_price: '2.5' },
    });
    // Сотруднику и партнёру адрес клиента закрыт.
    expect(
      (await api().inject({ method: 'GET', url: '/client/call-requirements', headers: auth() }))
        .statusCode,
    ).toBe(403);
  }, 120_000);

  it('предел цены отсекает дорогих; никто не подходит — requirements_unmet', async () => {
    const operator = await operatorId();
    const dear = await createPartner(operator, 1, '3');
    const cheap = await createPartner(operator, 1, '1');
    const { channel, destination, clientToken } = await createChannel(operator);

    expect((await decide(channel, destination)).sims).toEqual([cheap.sims[0], dear.sims[0]]);

    await setRequirements(clientToken, { ...NONE, maxPrice: '2' });
    expect((await decide(channel, destination)).sims).toEqual([cheap.sims[0]]);

    await setRequirements(clientToken, { ...NONE, maxPrice: '0.5' });
    const rejected = await decide(channel, destination);
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.reason).toBe('requirements_unmet');
  }, 120_000);

  it('«не слушает записи» исключает партнёра, который их слушает; клиент видит отметку в ценах', async () => {
    const operator = await operatorId();
    const listener = await createPartner(operator, 1, '1');
    const quiet = await createPartner(operator, 1, '2');
    await withDatabase(async (execute) => {
      await execute(
        sql`update partners set listens_to_recordings = true where id = ${listener.id}`,
      );
    });
    const { channel, destination, clientToken } = await createChannel(operator);

    const prices = await api().inject({
      method: 'GET',
      url: '/client/prices',
      headers: bearer(clientToken),
    });
    const offers = prices.json<{
      offers: { alias_id: string; listens_to_recordings: boolean }[];
    }>().offers;
    const aliases = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select id, partner_id from partner_aliases where partner_id in (${listener.id}, ${quiet.id})`,
      );
      return result.rows as { id: string; partner_id: string }[];
    });
    const listens = (partnerId: string) =>
      offers.find(
        (offer) => offer.alias_id === aliases.find((alias) => alias.partner_id === partnerId)?.id,
      )?.listens_to_recordings;
    expect(listens(listener.id)).toBe(true);
    expect(listens(quiet.id)).toBe(false);

    expect((await decide(channel, destination)).sims[0]).toBe(listener.sims[0]);
    await setRequirements(clientToken, { ...NONE, noRecordingListeners: true });
    expect((await decide(channel, destination)).sims).toEqual([quiet.sims[0]]);
  }, 120_000);

  it('способ: «только SIP» без транков — requirements_unmet, «только SIM» — звонит', async () => {
    const operator = await operatorId();
    const partner = await createPartner(operator, 1, '1');
    const { channel, destination, clientToken } = await createChannel(operator);

    await setRequirements(clientToken, { ...NONE, terminationKind: 'sip' });
    const rejected = await decide(channel, destination);
    expect(rejected.reason).toBe('requirements_unmet');

    await setRequirements(clientToken, { ...NONE, terminationKind: 'sim' });
    expect((await decide(channel, destination)).sims).toEqual([partner.sims[0]]);
  }, 120_000);

  it('кандидатов нет и без требований — прежняя причина, а не requirements_unmet', async () => {
    const operator = await operatorId();
    const { channel, destination, clientToken } = await createChannel(operator);
    await setRequirements(clientToken, { ...NONE, maxPrice: '5' });
    const rejected = await decide(channel, destination);
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.reason).not.toBe('requirements_unmet');
  }, 120_000);
});
