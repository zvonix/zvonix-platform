/**
 * Разбор вызовов на реальной базе.
 *
 * Проверяется то, ради чего список и заведён: отказ виден вместе с причиной, а сама
 * запись достаточна для разбора без открывания соседних разделов — видно, чей клиент,
 * какой оператор и через кого ушёл вызов.
 *
 * Состояния партнёра и клиента переводятся **обработчиками**, а не записью в базу:
 * так проверяется настоящий путь, а не то, что мы сами вписали в таблицу.
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
let supportToken = '';
let clientToken = '';
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
  return `7930${String(1000000 + msisdnCounter)}`;
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

interface CallView {
  id: string;
  destination: string;
  status: string;
  failure_reason: string | null;
  duration_seconds: number | null;
  started_at: string;
  region: string | null;
  client: { id: string; name: string };
  channel: { id: string; name: string };
  operator: { id: string; name: string } | null;
  partner: { id: string; name: string; display_name: string | null } | null;
  gateway: { id: string; name: string } | null;
  sim: { id: string; msisdn: string } | null;
}

interface Listed {
  calls: CallView[];
  total: number;
}

interface Summary {
  total: number;
  by_status: { status: string; count: number }[];
  by_reason: { reason: string; count: number }[];
}

async function listCalls(query: string, headers = auth()): Promise<Listed> {
  const response = await get(`/calls${query}`, headers);
  expect(response.statusCode).toBe(200);
  return response.json<Listed>();
}

async function createUser(role: 'client' | 'partner'): Promise<string> {
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

async function login(email: string): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return response.json<{ token: string }>().token;
}

/** Отметка «оператор этого номера известен и подтверждён» — вместо похода наружу. */
async function resolveNumber(destination: string, operator: string): Promise<void> {
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into number_resolutions (id, msisdn, operator_id, source, resolved_at, expires_at)
      values (gen_random_uuid()::text::uuid, ${destination}, ${operator}, 'manual', now(), now() + interval '30 days')
    `);
  });
}

let operatorId = '';
let operatorName = '';
let partnerId = '';
let partnerAlias = '';
let clientA = '';
let channelA = '';
let clientB = '';
let channelB = '';
let simId = '';
let gatewayId = '';
const numbers = { ok: '', blocked: '', poor: '' };

/** Единая обстановка: партнёр с железом, два клиента, три вызова с разной судьбой. */
async function buildScenario(): Promise<void> {
  operatorName = unique('Оператор');
  operatorId = (await post('/operators', { name: operatorName })).json<{
    operator: { id: string };
  }>().operator.id;

  partnerAlias = unique('Партнёр');
  partnerId = (
    await post('/partners', {
      ownerUserId: await createUser('partner'),
      name: 'Иванов Иван',
      displayName: partnerAlias,
    })
  ).json<{ partner: { id: string } }>().partner.id;
  expect((await patch(`/partners/${partnerId}/status`, { status: 'verified' })).statusCode).toBe(
    200,
  );

  gatewayId = (await post('/gateways', { partnerId, name: unique('Шлюз'), type: 'goip' })).json<{
    gateway: { id: string };
  }>().gateway.id;
  await post(`/gateways/${gatewayId}/status`, { status: 'active' });
  // Маршрутизация выбирает только шлюзы, зарегистрированные на принявшем вызов узле.
  await registerGateway(api(), nodeKey, gatewayId);

  const port = (await post(`/gateways/${gatewayId}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;
  simId = (await post('/sim-cards', { partnerId, operatorId, msisdn: nextMsisdn() })).json<{
    sim: { id: string };
  }>().sim.id;
  await post(`/sim-cards/${simId}/status`, { status: 'active' });
  await post(`/gateway-ports/${port}/sim`, { simCardId: simId });

  await post('/partner-rates', {
    partnerId,
    operatorId,
    pricePerMinute: '10',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });

  // --- Клиент, у которого всё хорошо -------------------------------------------
  clientA = (
    await post('/clients', { ownerUserId: await createUser('client'), name: unique('Такси') })
  ).json<{ client: { id: string } }>().client.id;
  expect((await patch(`/clients/${clientA}/status`, { status: 'active' })).statusCode).toBe(200);
  channelA = (await post('/channels', { clientId: clientA, name: unique('Линия') })).json<{
    channel: { id: string };
  }>().channel.id;
  await post(`/channels/${channelA}/status`, { status: 'active' });
  await post('/commission-rules', {
    clientId: clientA,
    percentBasisPoints: 1500,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  await post(`/clients/${clientA}/deposit`, {
    amount: '10000',
    idempotencyKey: unique('deposit'),
    description: 'Пополнение под проверку',
  });

  // --- Клиент без денег ---------------------------------------------------------
  clientB = (
    await post('/clients', { ownerUserId: await createUser('client'), name: unique('Такси') })
  ).json<{ client: { id: string } }>().client.id;
  expect((await patch(`/clients/${clientB}/status`, { status: 'active' })).statusCode).toBe(200);
  channelB = (await post('/channels', { clientId: clientB, name: unique('Линия') })).json<{
    channel: { id: string };
  }>().channel.id;
  await post(`/channels/${channelB}/status`, { status: 'active' });
  await post('/commission-rules', {
    clientId: clientB,
    percentBasisPoints: 1500,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });

  numbers.ok = nextMsisdn();
  numbers.poor = nextMsisdn();
  numbers.blocked = '79552200001';
  await resolveNumber(numbers.ok, operatorId);
  await resolveNumber(numbers.poor, operatorId);

  // --- Состоявшийся разговор ----------------------------------------------------
  const uuid = unique('uuid');
  const routed = await post('/routing/preview', {
    callId: uuid,
    channelId: channelA,
    nodeId,
    destination: numbers.ok,
  });
  expect(routed.json<{ outcome: string }>().outcome).toBe('routed');
  const cdr = await post(
    '/node/cdr',
    {
      variables: {
        uuid,
        billsec: '60',
        hangup_cause: 'NORMAL_CLEARING',
        answer_stamp: '2026-09-02 07:15:00.000000',
        end_stamp: '2026-09-02 07:16:00.000000',
      },
    },
    { authorization: `Bearer ${nodeKey}` },
  );
  expect(cdr.statusCode).toBe(200);

  // --- Отказ до выбора железа: номер в чёрном списке -----------------------------
  expect(
    (await post('/blocked-numbers', { prefix: '7955', note: 'Проверка разбора' })).statusCode,
  ).toBe(201);
  const blocked = await post('/routing/preview', {
    callId: unique('uuid'),
    channelId: channelA,
    nodeId,
    destination: numbers.blocked,
  });
  expect(blocked.json<{ reason: string }>().reason).toBe('destination_blocked');

  // --- Отказ по неразобранному номеру: короткий набор (ADR-0042) ------------------
  const short = await post('/routing/preview', {
    callId: unique('uuid'),
    channelId: channelA,
    nodeId,
    destination: '112',
  });
  expect(short.json<{ reason: string }>().reason).toBe('destination_invalid');

  // --- Отказ после выбора железа: денег не хватает даже на резерв -----------------
  const poor = await post('/routing/preview', {
    callId: unique('uuid'),
    channelId: channelB,
    nodeId,
    destination: numbers.poor,
  });
  expect(poor.json<{ reason: string }>().reason).toBe('insufficient_funds');
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
  token = await login(email);

  const supportEmail = uniqueEmail();
  await api().get(IdentityService).createByAdmin({
    email: supportEmail,
    password: TEST_PASSWORD,
    fullName: 'Поддержка',
    role: 'support',
    status: 'active',
  });
  supportToken = await login(supportEmail);

  const clientEmail = uniqueEmail();
  await api().get(IdentityService).createByAdmin({
    email: clientEmail,
    password: TEST_PASSWORD,
    fullName: 'Клиент',
    role: 'client',
    status: 'active',
  });
  clientToken = await login(clientEmail);

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

  await buildScenario();
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('список вызовов', () => {
  it('показывает состоявшийся разговор вместе с окружением', async () => {
    const listed = await listCalls(`?destination=${numbers.ok}`);
    expect(listed.total).toBe(1);

    const call = listed.calls[0];
    expect(call?.status).toBe('completed');
    expect(call?.failure_reason).toBeNull();
    expect(call?.duration_seconds).toBe(60);
    expect(call?.client.id).toBe(clientA);
    expect(call?.channel.id).toBe(channelA);
    expect(call?.operator?.name).toBe(operatorName);
    // Административный контур: настоящее имя партнёра здесь видно (ADR-0014).
    expect(call?.partner?.name).toBe('Иванов Иван');
    expect(call?.partner?.display_name).toBe(partnerAlias);
    expect(call?.gateway?.id).toBe(gatewayId);
    expect(call?.sim?.id).toBe(simId);
  }, 120_000);

  it('вызов на короткий номер виден в списке и отбирается по набранному', async () => {
    // До ADR-0042 такого вызова в списке не было вовсе: отказ происходил до записи,
    // и на вопрос «диспетчер набрал 112, что произошло» отвечать было нечем.
    const listed = await listCalls('?destination=112');
    expect(listed.total).toBe(1);

    const call = listed.calls[0];
    expect(call?.status).toBe('failed');
    expect(call?.failure_reason).toBe('destination_invalid');
    expect(call?.destination).toBe('112');
    expect(call?.operator).toBeNull();
  }, 120_000);

  it('у отказа до выбора железа шлюз и SIM пусты, а причина названа', async () => {
    const listed = await listCalls(`?destination=${numbers.blocked}`);
    expect(listed.total).toBe(1);

    const call = listed.calls[0];
    expect(call?.status).toBe('failed');
    expect(call?.failure_reason).toBe('destination_blocked');
    expect(call?.operator).toBeNull();
    expect(call?.partner).toBeNull();
    expect(call?.gateway).toBeNull();
    expect(call?.sim).toBeNull();
    // Клиент и канал известны всегда: без канала вызова не бывает.
    expect(call?.client.id).toBe(clientA);
  }, 120_000);

  it('у отказа после выбора железа железо видно: разбирать есть что', async () => {
    const listed = await listCalls(`?destination=${numbers.poor}`);
    const call = listed.calls[0];
    expect(call?.failure_reason).toBe('insufficient_funds');
    expect(call?.gateway?.id).toBe(gatewayId);
    expect(call?.sim?.id).toBe(simId);
  }, 120_000);

  it('отбирает по причине отказа', async () => {
    const listed = await listCalls('?failureReason=destination_blocked');
    expect(listed.total).toBe(1);
    expect(listed.calls[0]?.destination).toBe(numbers.blocked);
  }, 120_000);

  it('отбирает по клиенту', async () => {
    const listed = await listCalls(`?clientId=${clientB}`);
    expect(listed.total).toBe(1);
    expect(listed.calls[0]?.channel.id).toBe(channelB);
  }, 120_000);

  it('отбирает по партнёру, и отказ без железа в отбор не попадает', async () => {
    const listed = await listCalls(`?partnerId=${partnerId}`);
    const destinations = listed.calls.map((call) => call.destination);
    expect(destinations).toContain(numbers.ok);
    expect(destinations).toContain(numbers.poor);
    expect(destinations).not.toContain(numbers.blocked);
  }, 120_000);

  it('приводит номер в отборе к каноническому виду', async () => {
    // Человек набирает так, как видит у себя: с восьмёрки, а не с семёрки.
    const local = `8${numbers.ok.slice(1)}`;
    const listed = await listCalls(`?destination=${encodeURIComponent(local)}`);
    expect(listed.total).toBe(1);
    expect(listed.calls[0]?.destination).toBe(numbers.ok);
  }, 120_000);

  it('свежие сверху', async () => {
    const listed = await listCalls('');
    const times = listed.calls.map((call) => Date.parse(call.started_at));
    expect([...times].sort((left, right) => right - left)).toEqual(times);
  }, 120_000);

  it('число записей считается по всему отбору, а не по странице', async () => {
    const listed = await listCalls('?limit=1');
    expect(listed.calls).toHaveLength(1);
    expect(listed.total).toBeGreaterThan(1);
  }, 120_000);

  it('период отсекает вызовы будущего', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const listed = await listCalls(`?from=${encodeURIComponent(future)}`);
    expect(listed.total).toBe(0);
    expect(listed.calls).toHaveLength(0);
  }, 120_000);

  it('пустое значение отбора означает «любое», а не отказ', async () => {
    const listed = await listCalls('?status=&failureReason=&destination=&from=&to=');
    expect(listed.total).toBeGreaterThan(0);
  }, 120_000);

  it('несуществующая причина отказа — отказ, а не молчаливо пустой список', async () => {
    const response = await get(`/calls?failureReason=${encodeURIComponent('нет-такой-причины')}`);
    expect(response.statusCode).toBe(400);
  }, 120_000);

  it('набор из одних цифр в отборе принимается: такие назначения в базе бывают', async () => {
    // С ADR-0042 в назначении может лежать не канонический номер, а цифры набранного.
    // Отбор по ним обязан работать — иначе увиденный в списке вызов не отобрать.
    const response = await get('/calls?destination=12345');
    expect(response.statusCode).toBe(200);
    expect(response.json<Listed>().total).toBe(0);
  }, 120_000);

  it('отбор без единой цифры — отказ: искать было бы нечего', async () => {
    expect((await get('/calls?destination=%23%23')).statusCode).toBe(400);
  }, 120_000);
});

describe('сводка', () => {
  it('считает весь период, а не выданную страницу', async () => {
    const response = await get('/calls/summary?limit=1');
    expect(response.statusCode).toBe(200);

    const summary = response.json<Summary>();
    expect(summary.total).toBe(4);
    expect(summary.by_status).toEqual(
      expect.arrayContaining([
        { status: 'completed', count: 1 },
        { status: 'failed', count: 3 },
      ]),
    );
    expect(summary.by_reason).toEqual(
      expect.arrayContaining([
        { reason: 'destination_blocked', count: 1 },
        { reason: 'insufficient_funds', count: 1 },
      ]),
    );
  }, 120_000);

  it('сужается тем же отбором, что и список', async () => {
    const response = await get(`/calls/summary?clientId=${clientB}`);
    const summary = response.json<Summary>();
    expect(summary.total).toBe(1);
    expect(summary.by_reason).toEqual([{ reason: 'insufficient_funds', count: 1 }]);
  }, 120_000);
});

describe('вызовы канала', () => {
  it('отдают то же окружение, что и общий список', async () => {
    const response = await get(`/channels/${channelB}/calls`);
    expect(response.statusCode).toBe(200);

    const calls = response.json<{ calls: CallView[] }>().calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.failure_reason).toBe('insufficient_funds');
    expect(calls[0]?.client.id).toBe(clientB);
  }, 120_000);
});

describe('доступ', () => {
  it('поддержка читает разбор наравне с администратором', async () => {
    const headers = { authorization: `Bearer ${supportToken}` };
    expect((await get('/calls', headers)).statusCode).toBe(200);
    expect((await get('/calls/summary', headers)).statusCode).toBe(200);
    expect((await get(`/channels/${channelA}/calls`, headers)).statusCode).toBe(200);
  }, 120_000);

  it('клиенту разбор по всей площадке закрыт: там чужие номера и чужие партнёры', async () => {
    const headers = { authorization: `Bearer ${clientToken}` };
    expect((await get('/calls', headers)).statusCode).toBe(403);
    expect((await get('/calls/summary', headers)).statusCode).toBe(403);
  }, 120_000);

  it('без входа не отдаётся ничего', async () => {
    const response = await api().inject({ method: 'GET', url: '/calls' });
    expect(response.statusCode).toBe(401);
  }, 120_000);
});
