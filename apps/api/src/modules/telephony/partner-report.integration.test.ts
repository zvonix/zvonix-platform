/**
 * Обращение партнёра «вызов ушёл не в мою сеть» (ADR-0013).
 *
 * Партнёр видит счёт от своего оператора и знает про неверное определение раньше нас:
 * у него это деньги, у нас — строка в базе. Поэтому его обращение отменяет запись
 * немедленно, не дожидаясь срока годности.
 *
 * Главное, что проверяется, — **границы**: обращение принимается только по своему
 * вызову. По произвольному номеру можно было бы гнать чужие номера на повторное
 * определение, а внешний источник держит два запроса в секунду на всю платформу.
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
  return `79${String(800000000 + msisdnCounter).slice(0, 9)}`;
};

async function post(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url, headers: auth(), payload });
}

async function createUser(role: 'client' | 'partner'): Promise<{ id: string; email: string }> {
  const email = uniqueEmail();
  const { IdentityService } = await import('../identity/identity.service.js');
  const created = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Владелец',
    role,
    status: 'active',
  });
  return { id: created.id, email };
}

async function loginAs(email: string): Promise<Record<string, string>> {
  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return { authorization: `Bearer ${login.json<{ token: string }>().token}` };
}

interface Environment {
  readonly partner: string;
  readonly partnerHeaders: Record<string, string>;
  readonly operator: string;
  readonly channel: string;
  readonly destination: string;
  readonly callId: string;
}

/** Партнёр со шлюзом, SIM и одним состоявшимся вызовом через маршрутизацию. */
async function environment(): Promise<Environment> {
  const operator = (await post('/operators', { name: unique('Оператор') })).json<{
    operator: { id: string };
  }>().operator.id;

  const owner = await createUser('partner');
  const partner = (
    await post('/partners', {
      ownerUserId: owner.id,
      name: 'Иванов Иван',
      displayName: unique('Партнёр'),
    })
  ).json<{ partner: { id: string } }>().partner.id;

  const client = (
    await post('/clients', { ownerUserId: (await createUser('client')).id, name: unique('Такси') })
  ).json<{ client: { id: string } }>().client.id;

  await withDatabase(async (execute) => {
    await execute(sql`update partners set status = 'verified' where id = ${partner}`);
    await execute(sql`update clients set status = 'active' where id = ${client}`);
  });

  const gateway = (
    await post('/gateways', { partnerId: partner, name: unique('Шлюз'), type: 'goip' })
  ).json<{ gateway: { id: string } }>().gateway.id;
  await post(`/gateways/${gateway}/status`, { status: 'active' });

  const port = (await post(`/gateways/${gateway}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;

  const sim = (
    await post('/sim-cards', { partnerId: partner, operatorId: operator, msisdn: nextMsisdn() })
  ).json<{ sim: { id: string } }>().sim.id;
  await post(`/sim-cards/${sim}/status`, { status: 'active' });
  await post(`/gateway-ports/${port}/sim`, { simCardId: sim });

  const channel = (
    await post('/channels', { clientId: client, name: unique('Линия'), recordingRequired: false })
  ).json<{ channel: { id: string } }>().channel.id;
  await post(`/channels/${channel}/status`, { status: 'active' });

  await post('/partner-rates', {
    partnerId: partner,
    operatorId: operator,
    pricePerMinute: '1',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  await post('/commission-rules', {
    clientId: client,
    percentBasisPoints: 0,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  await post(`/clients/${client}/deposit`, {
    amount: '10000',
    idempotencyKey: unique('deposit'),
    description: 'Пополнение под проверку',
  });

  const destination = nextMsisdn();
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into number_resolutions (id, msisdn, operator_id, source, resolved_at, expires_at)
      values (gen_random_uuid()::text::uuid, ${destination}, ${operator}::uuid, 'manual', now(), now() + interval '30 days')
    `);
  });

  const routed = await post('/routing/preview', {
    callId: unique('call'),
    channelId: channel,
    nodeId,
    destination,
  });
  const callId = routed.json<{ outcome: string; call_id: string }>().call_id;
  expect(routed.json<{ outcome: string }>().outcome).toBe('routed');

  return {
    partner,
    partnerHeaders: await loginAs(owner.email),
    operator,
    channel,
    destination,
    callId,
  };
}

async function invalidatedAt(msisdn: string): Promise<string | null> {
  return withDatabase(async (execute) => {
    const result = await execute(
      sql`select invalidated_at from number_resolutions where msisdn = ${msisdn}`,
    );
    return (result.rows[0] as { invalidated_at: string | null }).invalidated_at;
  });
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

  nodeId = (await post('/nodes', { name: unique('Узел') })).json<{ node: { id: string } }>().node
    .id;
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('обращение партнёра', () => {
  it('отменяет определение оператора по своему вызову', async () => {
    const env = await environment();
    expect(await invalidatedAt(env.destination)).toBeNull();

    const response = await api().inject({
      method: 'POST',
      url: `/calls/${env.callId}/wrong-network`,
      headers: env.partnerHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ invalidated: boolean }>().invalidated).toBe(true);

    // Отмена немедленная: срок годности записи ещё не вышел, но она уже недействительна.
    expect(await invalidatedAt(env.destination)).not.toBeNull();
  }, 180_000);

  it('чужой вызов отвечает «не найдено», а не «запрещено»', async () => {
    // Иначе по разнице ответов проверяется, обслуживал ли вызов кто-то другой.
    const mine = await environment();
    const foreign = await environment();

    const response = await api().inject({
      method: 'POST',
      url: `/calls/${foreign.callId}/wrong-network`,
      headers: mine.partnerHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(await invalidatedAt(foreign.destination)).toBeNull();
  }, 180_000);

  it('партнёр видит свои вызовы и не видит чужих', async () => {
    const mine = await environment();
    const foreign = await environment();

    const listed = await api().inject({
      method: 'GET',
      url: '/partner/calls',
      headers: mine.partnerHeaders,
    });
    expect(listed.statusCode).toBe(200);

    const ids = listed.json<{ calls: { id: string }[] }>().calls.map((row) => row.id);
    expect(ids).toContain(mine.callId);
    expect(ids).not.toContain(foreign.callId);
  }, 180_000);

  it('администратор смотрит вызовы названного партнёра', async () => {
    const env = await environment();

    const listed = await api().inject({
      method: 'GET',
      url: `/partner/calls?partnerId=${env.partner}`,
      headers: auth(),
    });
    expect(listed.json<{ calls: { id: string }[] }>().calls.map((row) => row.id)).toContain(
      env.callId,
    );
  }, 180_000);

  it('записывает обращение в журнал: по нему видно, кто и о чём заявил', async () => {
    const env = await environment();
    await api().inject({
      method: 'POST',
      url: `/calls/${env.callId}/wrong-network`,
      headers: env.partnerHeaders,
    });

    const recorded = await withDatabase(async (execute) => {
      const result = await execute(sql`
        select actor_role from audit_log
         where entity_id = ${env.callId} and action = 'call.wrong_network_reported'
      `);
      return result.rows[0] as { actor_role: string } | undefined;
    });
    expect(recorded?.actor_role).toBe('partner');
  }, 180_000);

  it('повторное обращение по тому же вызову отвечает честно', async () => {
    // Запись уже отменена: отменять нечего, и делать вид, что что-то произошло, незачем.
    const env = await environment();
    const url = `/calls/${env.callId}/wrong-network`;

    expect(
      (await api().inject({ method: 'POST', url, headers: env.partnerHeaders })).json<{
        invalidated: boolean;
      }>().invalidated,
    ).toBe(true);
    expect(
      (await api().inject({ method: 'POST', url, headers: env.partnerHeaders })).json<{
        invalidated: boolean;
      }>().invalidated,
    ).toBe(false);
  }, 180_000);
});
