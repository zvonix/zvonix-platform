/**
 * Распределение звонков между картами партнёра ([ADR-0080](../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md))
 * на реальной базе: порядок карт одного партнёра, отметка выданного вызова, настройка и вес через кабинет партнёра.
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

async function route(channel: string, destination: string): Promise<string> {
  const response = await post('/routing/preview', {
    callId: unique('call'),
    channelId: channel,
    nodeId,
    destination,
  });
  expect(response.statusCode).toBe(201);
  const preview = response.json<{
    outcome: string;
    reason?: string;
    candidates: { sim_card_id: string }[];
  }>();
  expect(`${preview.outcome} ${preview.reason ?? ''}`.trim()).toBe('routed');
  const first = preview.candidates[0];
  if (first === undefined) throw new Error('Кандидатов нет');
  return first.sim_card_id;
}

const setMode = (partnerId: string, mode: string) =>
  withDatabase(async (execute) => {
    await execute(sql`
      insert into partner_distributions (id, partner_id, product, mode)
      values (gen_random_uuid()::text::uuid, ${partnerId}, 'call', ${mode})
      on conflict (partner_id, product) do update set mode = excluded.mode
    `);
  });

const setSim = (
  simId: string,
  columns: { priority?: number; weight?: number; routedSecondsAgo?: number | null },
) =>
  withDatabase(async (execute) => {
    if (columns.priority !== undefined) {
      await execute(
        sql`update sim_cards set distribution_priority = ${columns.priority} where id = ${simId}`,
      );
    }
    if (columns.weight !== undefined) {
      await execute(
        sql`update sim_cards set distribution_weight = ${columns.weight} where id = ${simId}`,
      );
    }
    if (columns.routedSecondsAgo !== undefined) {
      await execute(
        columns.routedSecondsAgo === null
          ? sql`update sim_cards set last_routed_at = null where id = ${simId}`
          : sql`update sim_cards set last_routed_at = now() - make_interval(secs => ${columns.routedSecondsAgo}) where id = ${simId}`,
      );
    }
  });

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

describe('распределение звонков между картами партнёра', () => {
  it('«поровну» по умолчанию: вызовы идут по кругу, а не на карту с наименьшим номером', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;
    const partner = await createPartner(operator, 3);
    const { channel, destination } = await createChannel(operator);

    const chosen = [
      await route(channel, destination),
      await route(channel, destination),
      await route(channel, destination),
    ];
    expect(new Set(chosen).size).toBe(3);
    // Четвёртый вызов — снова на самую давнюю карту.
    expect(await route(channel, destination)).toBe(chosen[0]);
    expect(partner.sims).toEqual(expect.arrayContaining(chosen));
  });

  it('«по очереди»: вызовы идут на карту с наименьшим номером в списке, пока она принимает', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;
    const partner = await createPartner(operator, 3);
    const { channel, destination } = await createChannel(operator);
    const last = partner.sims[2];
    if (last === undefined) throw new Error('Карт нет');
    await setSim(last, { priority: 1 });
    await setSim(partner.sims[0] ?? last, { priority: 2 });
    await setSim(partner.sims[1] ?? last, { priority: 3 });
    await setMode(partner.id, 'sequential');

    expect(await route(channel, destination)).toBe(last);
    expect(await route(channel, destination)).toBe(last);
    expect(await route(channel, destination)).toBe(last);
  });

  it('«по весам»: первой идёт карта, у которой простой, умноженный на вес, больше', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;
    const partner = await createPartner(operator, 2);
    const [heavy, light] = partner.sims;
    if (heavy === undefined || light === undefined) throw new Error('Карт нет');
    await setMode(partner.id, 'weighted');
    await setSim(heavy, { weight: 3, routedSecondsAgo: 60 });
    await setSim(light, { weight: 1, routedSecondsAgo: 100 });
    const { channel, destination } = await createChannel(operator);
    expect(await route(channel, destination)).toBe(heavy); // 180 против 100

    await setSim(heavy, { routedSecondsAgo: 30 });
    await setSim(light, { routedSecondsAgo: 300 });
    expect(await route(channel, destination)).toBe(light); // 90 против 300
  });

  it('вызов отмечает карту: у выбранной last_routed_at заполнено, у остальных нет', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;
    const partner = await createPartner(operator, 2);
    const { channel, destination } = await createChannel(operator);
    const chosen = await route(channel, destination);
    const marks = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select id, last_routed_at is not null as marked from sim_cards where partner_id = ${partner.id}`,
      );
      return result.rows as { id: string; marked: boolean }[];
    });
    expect(marks.find((row) => row.id === chosen)?.marked).toBe(true);
    expect(marks.filter((row) => row.marked)).toHaveLength(1);
  });
});

describe('настройка распределения звонков через кабинет партнёра', () => {
  const body = (patch: Record<string, unknown> = {}) => ({
    mode: 'equal',
    reservePercent: 0,
    quietFromMinute: null,
    quietToMinute: null,
    timezone: 'Europe/Moscow',
    stickyRecipient: false,
    ...patch,
  });

  it('читается, сохраняется, неверное отвергается; вес и приоритет — только своей карты', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;
    const mine = await createPartner(operator, 2);
    const other = await createPartner(operator, 1);

    const initial = await api().inject({
      method: 'GET',
      url: '/partner/distribution/calls',
      headers: bearer(mine.ownerToken),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json<{ settings: { mode: string }; sims: unknown[] }>().settings.mode).toBe(
      'equal',
    );
    expect(initial.json<{ sims: unknown[] }>().sims).toHaveLength(2);

    const saved = await api().inject({
      method: 'PUT',
      url: '/partner/distribution/calls',
      headers: bearer(mine.ownerToken),
      payload: body({ mode: 'remaining', reservePercent: 15 }),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ settings: Record<string, unknown> }>().settings).toMatchObject({
      mode: 'remaining',
      reserve_percent: 15,
    });
    const rejected = await api().inject({
      method: 'PUT',
      url: '/partner/distribution/calls',
      headers: bearer(mine.ownerToken),
      payload: body({ mode: 'случайно' }),
    });
    expect(rejected.statusCode).toBe(400);

    const mySim = mine.sims[0] ?? '';
    const ranked = await api().inject({
      method: 'PATCH',
      url: `/partner/sims/${mySim}/distribution`,
      headers: bearer(mine.ownerToken),
      payload: { weight: 4, priority: 2 },
    });
    expect(ranked.statusCode).toBe(200);
    expect(ranked.json<{ sim: { weight: number; priority: number } }>().sim).toMatchObject({
      weight: 4,
      priority: 2,
    });
    const foreign = await api().inject({
      method: 'PATCH',
      url: `/partner/sims/${other.sims[0] ?? ''}/distribution`,
      headers: bearer(mine.ownerToken),
      payload: { weight: 2 },
    });
    expect(foreign.statusCode).toBe(404);
    const outOfRange = await api().inject({
      method: 'PATCH',
      url: `/partner/sims/${mySim}/distribution`,
      headers: bearer(mine.ownerToken),
      payload: { priority: 0 },
    });
    expect(outOfRange.statusCode).toBe(400);
  });
});
