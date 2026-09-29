/**
 * Тестовый звонок с SIM на реальной базе
 * ([ADR-0055](../../../../../docs/adr/0055-testovyy-zvonok-s-sim.md)).
 *
 * Узел заменён поддельным ESL: он принимает пароль и отвечает на `originate` заданным
 * ответом. Проверяется то, что без живого FreeSWITCH проверить можно: пароль ESL
 * хранится и отдаётся только своей машине, команда набирает ту же линию, что
 * маршрутизация, партнёр не дотягивается до чужих карт, предел держится, CDR пробы
 * принимается вне биллинга.
 */

import { createServer, type AddressInfo, type Server } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  registerPort,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
  withDatabase,
} from '../../testing/harness.js';
import { NodesService } from '../nodes/nodes.service.js';
import { parseOriginateReply } from './test-call.service.js';

prepareEnvironment();

const REALM = 'sip.zvonix.test';
const ESL_PASSWORD = 'a'.repeat(48);

let app: NestFastifyApplication | undefined;
let adminToken = '';
let nodeId = '';
let nodeKey = '';
let operatorId = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const as = (bearer: string) => ({ authorization: `Bearer ${bearer}` });

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

let msisdnCounter = 0;
const nextMsisdn = (): string => {
  msisdnCounter += 1;
  return `7942${String(1000000 + msisdnCounter)}`;
};

async function post(url: string, payload: Record<string, unknown>, bearer = adminToken) {
  return api().inject({ method: 'POST', url, headers: as(bearer), payload });
}

async function get(url: string, bearer = adminToken) {
  return api().inject({ method: 'GET', url, headers: as(bearer) });
}

async function login(email: string): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return response.json<{ token: string }>().token;
}

async function createUser(role: 'admin' | 'partner'): Promise<{ id: string; token: string }> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  const created = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Человек',
    role,
    status: 'active',
  });
  return { id: created.id, token: await login(email) };
}

async function createPartner(): Promise<{ id: string; token: string }> {
  const owner = await createUser('partner');
  const id = (
    await post('/partners', {
      ownerUserId: owner.id,
      name: unique('Партнёр'),
      displayName: unique('Псевдоним'),
    })
  ).json<{ partner: { id: string } }>().partner.id;
  const verified = await api().inject({
    method: 'PATCH',
    url: `/partners/${id}/status`,
    headers: as(adminToken),
    payload: { status: 'verified' },
  });
  expect(verified.statusCode).toBe(200);
  return { id, token: owner.token };
}

interface Gateway {
  id: string;
  ports: { port_id: string; port_number: number; username: string }[];
}

/** GOIP со входом по линиям, включённый. */
async function createGateway(partnerToken: string, portCount: number): Promise<Gateway> {
  const response = await post(
    '/partner/gateways',
    { name: unique('GOIP'), type: 'goip', portCount, registrationMode: 'port' },
    partnerToken,
  );
  expect(response.statusCode).toBe(201);
  const body = response.json<{ gateway: { id: string }; port_accounts: Gateway['ports'] }>();
  await post(`/partner/gateways/${body.gateway.id}/status`, { status: 'active' }, partnerToken);
  return { id: body.gateway.id, ports: body.port_accounts };
}

/** Карта в порту; `registered` — линия уже подключилась к узлу. */
async function simInPort(
  partnerToken: string,
  port: Gateway['ports'][number],
  registered = true,
): Promise<string> {
  const sim = (
    await post('/partner/sim-cards', { operatorId, msisdn: nextMsisdn() }, partnerToken)
  ).json<{ sim: { id: string } }>().sim;
  const assigned = await post(
    `/partner/gateway-ports/${port.port_id}/sim`,
    { simCardId: sim.id },
    partnerToken,
  );
  expect(assigned.statusCode).toBe(201);
  if (registered) await registerPort(api(), nodeKey, port.port_id);
  return sim.id;
}

// --- Поддельный ESL -----------------------------------------------------------

let esl: Server | undefined;
let eslPort = 0;
/** Что ответит поддельный узел на следующий `originate`. */
let nextReply = '+OK 00000000-0000-4000-8000-000000000000';
const commands: string[] = [];

function frame(headers: Record<string, string>, body = ''): string {
  const length = Buffer.byteLength(body, 'utf8');
  const all = length > 0 ? { ...headers, 'Content-Length': String(length) } : headers;
  return (
    Object.entries(all)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n') + `\n\n${body}`
  );
}

async function startFakeEsl(): Promise<void> {
  esl = createServer((socket) => {
    let received = '';
    socket.write(frame({ 'Content-Type': 'auth/request' }));
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      for (;;) {
        const end = received.indexOf('\n\n');
        if (end === -1) return;
        const line = received.slice(0, end);
        received = received.slice(end + 2);
        if (line.startsWith('auth ')) {
          const ok = line === `auth ${ESL_PASSWORD}`;
          socket.write(
            frame({ 'Content-Type': 'command/reply', 'Reply-Text': ok ? '+OK accepted' : '-ERR' }),
          );
        } else if (line.startsWith('api ')) {
          commands.push(line.slice('api '.length));
          socket.write(frame({ 'Content-Type': 'api/response' }, `${nextReply}\n`));
        } else if (line === 'exit') {
          socket.end();
        }
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => esl?.listen(0, '127.0.0.1', resolve));
  eslPort = (esl.address() as AddressInfo).port;
}

/** Ждём, пока проба выйдет из `dialing` — фон пишет итог сам. */
async function settled(id: string, bearer: string, path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const view = (await get(`${path}/${id}`, bearer)).json<{
      test_call: { status: string; hangup_cause: string | null };
    }>().test_call;
    if (view.status !== 'dialing') return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Итог пробы не пришёл');
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  adminToken = (await createUser('admin')).token;

  const provisioned = await post('/nodes', { name: unique('Узел') });
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

  operatorId = (await post('/operators', { name: unique('Оператор') })).json<{
    operator: { id: string };
  }>().operator.id;

  await startFakeEsl();
}, 240_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => {
    if (esl === undefined) resolve();
    else
      esl.close(() => {
        resolve();
      });
  });
  await app?.close();
});

describe('пароль ESL узла', () => {
  it('узел своей машины сообщает пароль, площадка хранит его зашифрованным', async () => {
    const response = await api().inject({
      method: 'PUT',
      url: '/node/esl',
      headers: as(nodeKey),
      payload: { password: ESL_PASSWORD },
    });
    expect(response.statusCode).toBe(200);

    const stored = await withDatabase(async (execute) => {
      const result = await execute(sql`select esl_secret from nodes where id = ${nodeId}`);
      return (result.rows[0] as { esl_secret: string } | undefined)?.esl_secret;
    });
    expect(stored).toBeDefined();
    expect(stored).not.toContain(ESL_PASSWORD);

    const target = await api()
      .get(NodesService)
      .eslTargetOf(nodeId as Parameters<NodesService['eslTargetOf']>[0]);
    expect(target).toEqual({ host: '127.0.0.1', port: 8021, password: ESL_PASSWORD });

    // В ответ человеку пароль не попадает ни в каком виде.
    const view = await get(`/nodes/${nodeId}`);
    expect(view.body).not.toContain('esl');
  });

  it('узел с чужой машины получает 409: ESL его закрыт для площадки', async () => {
    const provisioned = await post('/nodes', { name: unique('Дальний узел') });
    const command = provisioned.json<{ install: { command: string } }>().install.command;
    const remote = '203.0.113.7';
    const enrolled = await api().inject({
      method: 'POST',
      url: '/node/enroll',
      remoteAddress: remote,
      headers: as(command.slice(command.lastIndexOf(' ') + 1)),
      payload: { hostname: unique('far'), agentVersion: '1.0.0' },
    });
    const key = enrolled.json<{ key: { key_id: string; secret: string } }>().key;

    const response = await api().inject({
      method: 'PUT',
      url: '/node/esl',
      remoteAddress: remote,
      headers: as(`${key.key_id}.${key.secret}`),
      payload: { password: ESL_PASSWORD },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'esl_not_local',
    );
  });

  it('не шестнадцатеричный пароль не принимается — перевод строки в нём стал бы командой', async () => {
    const response = await api().inject({
      method: 'PUT',
      url: '/node/esl',
      headers: as(nodeKey),
      payload: { password: `${ESL_PASSWORD}\n\napi shutdown` },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('тестовый звонок с SIM', () => {
  let partner: { id: string; token: string };
  let neighbour: { id: string; token: string };
  let gateway: Gateway;

  beforeAll(async () => {
    // Узел отвечает поддельным ESL; настоящий `eslTargetOf` проверен выше.
    vi.spyOn(api().get(NodesService), 'eslTargetOf').mockImplementation(() =>
      Promise.resolve({ host: '127.0.0.1', port: eslPort, password: ESL_PASSWORD }),
    );
    partner = await createPartner();
    neighbour = await createPartner();
    gateway = await createGateway(partner.token, 6);
  });

  function port(number: number): Gateway['ports'][number] {
    const found = gateway.ports.find((row) => row.port_number === number);
    if (found === undefined) throw new Error(`Нет порта ${String(number)}`);
    return found;
  }

  it('звонит с линии карты и показывает итог «ответили»', async () => {
    const simId = await simInPort(partner.token, port(1));
    nextReply = '+OK 5f1c7d2e-0000-4000-8000-000000000001';

    const started = await post(
      `/partner/sim-cards/${simId}/test-call`,
      { destination: '+7 (913) 000-11-22' },
      partner.token,
    );
    expect(started.statusCode).toBe(202);
    const call = started.json<{ test_call: { id: string; status: string; destination: string } }>()
      .test_call;
    expect(call.destination).toBe('79130001122');

    const done = await settled(call.id, partner.token, '/partner/test-calls');
    expect(done.status).toBe('answered');

    // Набрана линия карты — так же, как её набирает маршрутизация (ADR-0054).
    const command = commands.at(-1) ?? '';
    expect(command).toContain(`zvonix_test_call=${call.id}`);
    expect(command).toContain(`[zvonix_dial=9900179130001122]user/${port(1).username}@${REALM}`);
    expect(command).toMatch(/^originate \{.*originate_timeout=40.*\}\[/u);
    expect(command).toContain('&playback(tone_stream://');
  });

  it('CDR пробы принимается вне биллинга и дописывает разговор', async () => {
    const simId = await simInPort(partner.token, port(2));
    nextReply = '+OK 5f1c7d2e-0000-4000-8000-000000000002';
    const call = (
      await post(
        `/partner/sim-cards/${simId}/test-call`,
        { destination: '79130001123' },
        partner.token,
      )
    ).json<{ test_call: { id: string } }>().test_call;
    await settled(call.id, partner.token, '/partner/test-calls');

    const cdr = await api().inject({
      method: 'POST',
      url: '/node/cdr',
      headers: as(nodeKey),
      payload: {
        variables: {
          uuid: call.id,
          zvonix_test_call: call.id,
          billsec: '4',
          hangup_cause: 'NORMAL_CLEARING',
          sip_term_status: '200',
          answer_stamp: '2026-09-25 10:00:00.000000',
          end_stamp: '2026-09-25 10:00:04.000000',
        },
      },
    });
    expect(cdr.statusCode).toBe(200);
    expect(cdr.json<{ outcome: string }>().outcome).toBe('test_call');

    const view = (await get(`/partner/test-calls/${call.id}`, partner.token)).json<{
      test_call: { status: string; talk_seconds: number; sip_status: string };
    }>().test_call;
    expect(view).toMatchObject({ status: 'answered', talk_seconds: 4, sip_status: '200' });

    // Денег проба не двигает: проводок по ней нет.
    const entries = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as n from ledger_transactions where idempotency_key like ${`%${call.id}%`}`,
      );
      return (result.rows[0] as { n: number }).n;
    });
    expect(entries).toBe(0);
  });

  it('занято — итог «занято», причина FreeSWITCH сохраняется', async () => {
    const simId = await simInPort(partner.token, port(3));
    nextReply = '-ERR USER_BUSY';
    const call = (
      await post(
        `/partner/sim-cards/${simId}/test-call`,
        { destination: '79130001124' },
        partner.token,
      )
    ).json<{ test_call: { id: string } }>().test_call;
    const done = await settled(call.id, partner.token, '/partner/test-calls');
    expect(done).toMatchObject({ status: 'busy', hangup_cause: 'USER_BUSY' });
  });

  it('вторая проба с той же карты раньше минуты — 429 с Retry-After', async () => {
    const simId = await simInPort(partner.token, port(4));
    nextReply = '-ERR NO_ANSWER';
    const first = await post(
      `/partner/sim-cards/${simId}/test-call`,
      { destination: '79130001125' },
      partner.token,
    );
    expect(first.statusCode).toBe(202);
    await settled(
      first.json<{ test_call: { id: string } }>().test_call.id,
      partner.token,
      '/partner/test-calls',
    );

    const second = await post(
      `/partner/sim-cards/${simId}/test-call`,
      { destination: '79130001125' },
      partner.token,
    );
    expect(second.statusCode).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('линия, не подключившаяся к узлу, — 409 с понятной причиной, без звонка', async () => {
    const simId = await simInPort(partner.token, port(5), false);
    const before = commands.length;
    const response = await post(
      `/partner/sim-cards/${simId}/test-call`,
      { destination: '79130001126' },
      partner.token,
    );
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'not_registered',
    );
    expect(commands.length).toBe(before);
  });

  it('чужую карту и чужую пробу партнёр не видит — 404', async () => {
    const simId = await simInPort(partner.token, port(6));
    nextReply = '+OK';
    const foreign = await post(
      `/partner/sim-cards/${simId}/test-call`,
      { destination: '79130001127' },
      neighbour.token,
    );
    expect(foreign.statusCode).toBe(404);

    const own = (
      await post(
        `/partner/sim-cards/${simId}/test-call`,
        { destination: '79130001127' },
        partner.token,
      )
    ).json<{ test_call: { id: string } }>().test_call;
    expect((await get(`/partner/test-calls/${own.id}`, neighbour.token)).statusCode).toBe(404);
    // Администратор видит любую.
    expect((await get(`/test-calls/${own.id}`)).statusCode).toBe(200);
  });

  it('администратор звонит с любой карты, запись попадает в журнал с маской номера', async () => {
    const extra = await createGateway(partner.token, 1);
    const [line] = extra.ports;
    if (line === undefined) throw new Error('Нет порта');
    const simId = await simInPort(partner.token, line);
    nextReply = '+OK';
    const started = await post(`/sim-cards/${simId}/test-call`, { destination: '79130001128' });
    expect(started.statusCode).toBe(202);

    const audit = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select after from audit_log where action = 'sim_card.test_call' and entity_id = ${simId}`,
      );
      return (result.rows[0] as { after: { destination: string } } | undefined)?.after;
    });
    expect(audit?.destination).toBe('7913*****28');
  });

  it('отказ сети после набора: CDR дописывает ответ шлюза дословно и отметку «набирал»', async () => {
    // Так выглядела проба на живом GOIP (2026-09-25): «183 Ringing», затем отказ через
    // полминуты. Кабинет должен назвать участок — сеть оператора, — а не гадать о карте.
    const extra = await createGateway(partner.token, 1);
    const [line] = extra.ports;
    if (line === undefined) throw new Error('Нет порта');
    const simId = await simInPort(partner.token, line);
    nextReply = '-ERR NORMAL_TEMPORARY_FAILURE';
    const call = (
      await post(
        `/partner/sim-cards/${simId}/test-call`,
        { destination: '79130001129' },
        partner.token,
      )
    ).json<{ test_call: { id: string } }>().test_call;
    await settled(call.id, partner.token, '/partner/test-calls');

    const cdr = await api().inject({
      method: 'POST',
      url: '/node/cdr',
      headers: as(nodeKey),
      payload: {
        variables: {
          uuid: call.id,
          zvonix_test_call: call.id,
          billsec: '0',
          hangup_cause: 'NORMAL_TEMPORARY_FAILURE',
          sip_invite_failure_status: '503',
          sip_invite_failure_phrase: 'Service Unavailable',
          progress_stamp: '2026-09-25 12:49:40.000000',
        },
      },
    });
    expect(cdr.statusCode).toBe(200);

    const view = (await get(`/partner/test-calls/${call.id}`, partner.token)).json<{
      test_call: { status: string; sip_status: string; sip_phrase: string; rang: boolean };
    }>().test_call;
    expect(view).toMatchObject({
      status: 'failed',
      sip_status: '503',
      sip_phrase: 'Service Unavailable',
      rang: true,
    });
  });

  it('номер не российский — 400', async () => {
    const response = await post(
      `/partner/sim-cards/${gateway.ports[0]?.port_id ?? ''}/test-call`,
      { destination: '12345' },
      partner.token,
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('ответ originate', () => {
  it.each([
    ['+OK 5f1c7d2e-0000-4000-8000-000000000001', 'answered', null],
    ['-ERR USER_BUSY', 'busy', 'USER_BUSY'],
    ['-ERR NO_ANSWER', 'no_answer', 'NO_ANSWER'],
    ['-ERR USER_NOT_REGISTERED', 'failed', 'USER_NOT_REGISTERED'],
    ['-ERR ORIGINATOR_CANCEL', 'failed', 'ORIGINATOR_CANCEL'],
  ])('%s → %s', (reply, status, cause) => {
    expect(parseOriginateReply(reply)).toEqual({ status, hangupCause: cause });
  });

  it('непонятный ответ — отказ с самим ответом, а не «ответили»', () => {
    expect(parseOriginateReply('что-то не то')).toEqual({
      status: 'failed',
      hangupCause: 'UNEXPECTED_REPLY: что-то не то',
    });
  });
});
