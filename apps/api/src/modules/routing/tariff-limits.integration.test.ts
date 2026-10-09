/**
 * Лимиты в тарифе звонков ([ADR-0080](../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)) на реальной базе:
 * лимит тарифа считается у каждой карты отдельно, исчерпанная карта выходит из перебора, карты другого тарифа не задеты.
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
async function createPartner(operatorId: string, count: number): Promise<Partner> {
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
    pricePerMinute: '1',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  return { id: partner, ownerToken: owner.token, sims };
}

async function createChannel(
  operatorId: string,
): Promise<{ channel: string; destination: string }> {
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
  return { channel, destination };
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

/** Партнёрский тариф с той же ценой, что у основного, и лимитом «звонков в сутки» (через кабинет партнёра). */
async function limitedTariff(partner: Partner, operatorId: string, calls: number | null) {
  const tariff = (
    await api().inject({
      method: 'POST',
      url: '/partner/tariffs',
      headers: bearer(partner.ownerToken),
      payload: { name: unique('Лимитный') },
    })
  ).json<{ tariff: { id: string } }>().tariff.id;
  const priced = await api().inject({
    method: 'POST',
    url: '/partner/rates',
    headers: bearer(partner.ownerToken),
    payload: { tariffId: tariff, operatorId, terminationKind: 'sim', pricePerMinute: '1' },
  });
  expect(priced.statusCode).toBe(201);
  if (calls !== null) {
    const limit = await api().inject({
      method: 'POST',
      url: '/partner/limits',
      headers: bearer(partner.ownerToken),
      payload: { scope: 'tariff', tariffId: tariff, window: 'day', metric: 'calls', value: calls },
    });
    expect(limit.statusCode).toBe(201);
  }
  return tariff;
}

const useTariff = (simId: string, tariffId: string) =>
  withDatabase(async (execute) => {
    await execute(sql`update sim_cards set tariff_id = ${tariffId} where id = ${simId}`);
  });

const callsOf = async (simId: string): Promise<number> =>
  withDatabase(async (execute) => {
    const result = await execute(
      sql`select count(*)::int as n from calls where sim_card_id = ${simId}`,
    );
    return (result.rows[0] as { n: number }).n;
  });

const preview = (channel: string, destination: string) =>
  post('/routing/preview', { callId: unique('call'), channelId: channel, nodeId, destination });

describe('лимиты в тарифе звонков (ADR-0080)', () => {
  it('лимит тарифа считается у каждой карты отдельно и закрывает карту, а не партнёра', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;
    const partner = await createPartner(operator, 2);
    const { channel, destination } = await createChannel(operator);
    const tariff = await limitedTariff(partner, operator, 1);
    for (const sim of partner.sims) await useTariff(sim, tariff);

    // Каждая карта принимает по одному вызову в сутки: два вызова уходят на разные карты.
    expect((await preview(channel, destination)).json<{ outcome: string }>().outcome).toBe(
      'routed',
    );
    expect((await preview(channel, destination)).json<{ outcome: string }>().outcome).toBe(
      'routed',
    );
    for (const sim of partner.sims) expect(await callsOf(sim)).toBe(1);

    // Обе карты исчерпали лимит тарифа — вызов отклонён по лимиту, а не «нет карт».
    const third = (await preview(channel, destination)).json<{
      outcome: string;
      reason?: string;
    }>();
    expect(third).toMatchObject({ outcome: 'rejected', reason: 'limit_exceeded' });
  }, 120_000);

  it('карта с другим тарифом лимитом не задета', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;
    const partner = await createPartner(operator, 2);
    const { channel, destination } = await createChannel(operator);
    const tariff = await limitedTariff(partner, operator, 1);
    const [limited, free] = partner.sims;
    if (limited === undefined || free === undefined) throw new Error('Нужны две карты');
    await useTariff(limited, tariff);

    for (let index = 0; index < 4; index += 1) {
      expect((await preview(channel, destination)).json<{ outcome: string }>().outcome).toBe(
        'routed',
      );
    }
    // Карта с лимитом приняла не больше одного вызова, остальное ушло на карту основного тарифа.
    expect(await callsOf(limited)).toBeLessThanOrEqual(1);
    expect(await callsOf(free)).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('кабинет показывает лимит тарифа по карте, которая работает по этому тарифу', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;
    const partner = await createPartner(operator, 1);
    const tariff = await limitedTariff(partner, operator, null);
    const sim = partner.sims[0] ?? '';
    await useTariff(sim, tariff);
    const added = await api().inject({
      method: 'POST',
      url: '/partner/limits',
      headers: bearer(partner.ownerToken),
      payload: { scope: 'tariff', tariffId: tariff, window: 'day', metric: 'minutes', value: 600 },
    });
    expect(added.statusCode).toBe(201);

    const listed = await api().inject({
      method: 'GET',
      url: '/partner/limits',
      headers: bearer(partner.ownerToken),
    });
    const body = listed.json<{
      limits: { tariff_id: string | null; usage_sim_card_id: string | null; metric: string }[];
      sims: { id: string; tariff_id: string }[];
    }>();
    // Строка лимита тарифа — по карте, которая работает по этому тарифу, и только по ней.
    const rows = body.limits.filter((row) => row.tariff_id === tariff);
    expect(rows.map((row) => row.usage_sim_card_id)).toEqual([sim]);
    expect(body.sims.map((card) => [card.id, card.tariff_id])).toEqual([[sim, tariff]]);
  }, 120_000);
});
