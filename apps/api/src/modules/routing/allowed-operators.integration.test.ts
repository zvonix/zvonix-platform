/**
 * Разрешённые операторы канала (ADR-0025).
 *
 * DOMAIN.md называл их среди атрибутов канала, ARCHITECTURE.md — среди проверок
 * маршрутизации, а проверки не было: канал звонил на любого оператора, для которого
 * нашлась SIM. Клиент, которому обещали ограничение направлений, узнал бы об этом
 * по счёту, а не по отказу.
 *
 * Проверяется на реальной базе: правило «списка нет — разрешены все» выражено в SQL
 * через `bool_or` по пустому множеству, и различить «список не заведён» и «заведён,
 * оператора в нём нет» подставным репозиторием было бы нечем.
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
  return `79${String(500000000 + msisdnCounter).slice(0, 9)}`;
};

async function post(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url, headers: auth(), payload });
}

async function put(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'PUT', url, headers: auth(), payload });
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

async function createOperator(): Promise<string> {
  const response = await post('/operators', { name: unique('Оператор') });
  return response.json<{ operator: { id: string } }>().operator.id;
}

/** Подтверждённый партнёр со шлюзом, портом, активной SIM и ценой. */
async function createPartner(operatorId: string): Promise<void> {
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

  const port = (await post(`/gateways/${gateway}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;

  const sim = (
    await post('/sim-cards', { partnerId: partner, operatorId, msisdn: nextMsisdn() })
  ).json<{ sim: { id: string } }>().sim.id;
  await post(`/sim-cards/${sim}/status`, { status: 'active' });
  await post(`/gateway-ports/${port}/sim`, { simCardId: sim });

  await post('/partner-rates', {
    partnerId: partner,
    operatorId,
    pricePerMinute: '1',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
}

interface Channel {
  readonly id: string;
  readonly clientId: string;
  readonly ownerUserId: string;
}

async function createChannel(): Promise<Channel> {
  const ownerUserId = await createUser('client');
  const client = (await post('/clients', { ownerUserId, name: unique('Такси') })).json<{
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

  return { id: channel, clientId: client, ownerUserId };
}

/** Номер с подтверждённым оператором. */
async function createDestination(operatorId: string): Promise<string> {
  const destination = nextMsisdn();
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into number_resolutions (id, msisdn, operator_id, source, resolved_at, expires_at)
      values (gen_random_uuid()::text::uuid, ${destination}, ${operatorId}, 'manual', now(), now() + interval '30 days')
    `);
  });
  return destination;
}

interface Preview {
  outcome: string;
  reason: string | null;
  sip_response: string | null;
}

async function route(channel: string, destination: string): Promise<Preview> {
  const response = await post('/routing/preview', {
    callId: unique('call'),
    channelId: channel,
    nodeId,
    destination,
  });
  expect(response.statusCode).toBe(201);
  return response.json<Preview>();
}

async function loginAs(email: string): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return response.json<{ token: string }>().token;
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
  token = await loginAs(email);

  nodeId = (await post('/nodes', { name: unique('Узел') })).json<{ node: { id: string } }>().node
    .id;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('отбор по разрешённым операторам', () => {
  it('без списка звонит на любого оператора', async () => {
    // Иначе новый канал не смог бы позвонить, пока кто-то не заполнит список,
    // и это выглядело бы поломкой платформы, а не его настройкой.
    const operator = await createOperator();
    await createPartner(operator);
    const channel = await createChannel();

    expect((await route(channel.id, await createDestination(operator))).outcome).toBe('routed');
  }, 120_000);

  it('со списком звонит на разрешённого', async () => {
    const operator = await createOperator();
    await createPartner(operator);
    const channel = await createChannel();

    expect(
      (await put(`/channels/${channel.id}/allowed-operators`, { operators: [operator] }))
        .statusCode,
    ).toBe(200);

    expect((await route(channel.id, await createDestination(operator))).outcome).toBe('routed');
  }, 120_000);

  it('отказывает по оператору вне списка — своей причиной, а не «нет SIM»', async () => {
    const allowed = await createOperator();
    const other = await createOperator();
    await createPartner(other);
    const channel = await createChannel();

    await put(`/channels/${channel.id}/allowed-operators`, { operators: [allowed] });

    const decision = await route(channel.id, await createDestination(other));
    expect(decision.outcome).toBe('rejected');
    // «Запрет платформы» и «моя собственная настройка» — два разных разговора
    // с клиентом, и сваливать их в одну причину нельзя.
    expect(decision.reason).toBe('operator_not_allowed');
    expect(decision.sip_response).toBe('403 Forbidden');
  }, 120_000);

  it('пустой список снимает ограничение', async () => {
    const allowed = await createOperator();
    const other = await createOperator();
    await createPartner(other);
    const channel = await createChannel();

    await put(`/channels/${channel.id}/allowed-operators`, { operators: [allowed] });
    expect((await route(channel.id, await createDestination(other))).reason).toBe(
      'operator_not_allowed',
    );

    await put(`/channels/${channel.id}/allowed-operators`, { operators: [] });
    expect((await route(channel.id, await createDestination(other))).outcome).toBe('routed');
  }, 120_000);
});

describe('ведение списка', () => {
  it('клиент задаёт список в своём канале и видит его', async () => {
    const operator = await createOperator();
    const channel = await createChannel();
    const clientToken = await loginAs(
      await withDatabase(async (execute) => {
        const rows = await execute(sql`select email from users where id = ${channel.ownerUserId}`);
        return (rows.rows[0] as { email: string }).email;
      }),
    );
    const headers = { authorization: `Bearer ${clientToken}` };

    const set = await api().inject({
      method: 'PUT',
      url: `/channels/${channel.id}/allowed-operators`,
      headers,
      payload: { operators: [operator] },
    });
    expect(set.statusCode).toBe(200);

    const listed = await api().inject({
      method: 'GET',
      url: `/channels/${channel.id}/allowed-operators`,
      headers,
    });
    expect(listed.json<{ operators: string[] }>().operators).toEqual([operator]);

    // Справочник операторов клиенту открыт: иначе выбирать не из чего.
    const directory = await api().inject({ method: 'GET', url: '/operators', headers });
    expect(directory.statusCode).toBe(200);
  }, 120_000);

  it('чужой канал отвечает «не найдено», а не «запрещено»', async () => {
    // Иначе по разнице ответов проверяется существование чужого канала.
    const operator = await createOperator();
    const mine = await createChannel();
    const foreign = await createChannel();
    const clientToken = await loginAs(
      await withDatabase(async (execute) => {
        const rows = await execute(sql`select email from users where id = ${mine.ownerUserId}`);
        return (rows.rows[0] as { email: string }).email;
      }),
    );

    const response = await api().inject({
      method: 'PUT',
      url: `/channels/${foreign.id}/allowed-operators`,
      headers: { authorization: `Bearer ${clientToken}` },
      payload: { operators: [operator] },
    });
    expect(response.statusCode).toBe(404);
  }, 120_000);

  it('отвергает неизвестного оператора', async () => {
    const channel = await createChannel();
    const response = await put(`/channels/${channel.id}/allowed-operators`, {
      operators: ['01a00000-0000-7000-8000-000000000000'],
    });
    expect(response.statusCode).toBe(404);
  }, 120_000);

  it('отвергает одного и того же оператора дважды', async () => {
    const operator = await createOperator();
    const channel = await createChannel();
    const response = await put(`/channels/${channel.id}/allowed-operators`, {
      operators: [operator, operator],
    });
    expect(response.statusCode).toBe(400);
  }, 120_000);
});
