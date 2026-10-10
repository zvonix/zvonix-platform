/**
 * Приоритеты партнёров у клиента ([ADR-0081](../../../../../docs/adr/0081-prioritety-partnyorov-u-klienta.md)) для звонков
 * на реальной базе: список клиента, цифры, «не использовать», партнёры вне списка, свой список линии главнее.
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

const preview = async (channel: string, destination: string): Promise<string[]> => {
  const response = await post('/routing/preview', {
    callId: unique('call'),
    channelId: channel,
    nodeId,
    destination,
  });
  expect(response.statusCode).toBe(201);
  return response
    .json<{ candidates: { sim_card_id: string }[] }>()
    .candidates.map((c) => c.sim_card_id);
};

const aliasOf = async (partnerId: string): Promise<string> =>
  withDatabase(async (execute) => {
    const result = await execute(
      sql`select id from partner_aliases where partner_id = ${partnerId}`,
    );
    return (result.rows[0] as { id: string }).id;
  });

const setClientList = (
  token: string,
  entries: { aliasId: string; offer?: string; priority: number | null }[],
) =>
  api().inject({
    method: 'PUT',
    url: '/client/partner-priorities?product=calls',
    headers: bearer(token),
    payload: { priorities: entries.map((entry) => ({ offer: 'sim', ...entry })) },
  });

const operatorId = async (): Promise<string> =>
  (await post('/operators', { name: unique('Оператор') })).json<{ operator: { id: string } }>()
    .operator.id;

describe('приоритеты партнёров у клиента: звонки (ADR-0081)', () => {
  it('цифра важнее цены: дорогой партнёр с цифрой 1 идёт перед дешёвым с цифрой 2', async () => {
    const operator = await operatorId();
    const dear = await createPartner(operator, 1, '3');
    const cheap = await createPartner(operator, 1, '1');
    const { channel, destination, clientToken } = await createChannel(operator);

    // Без списка — по цене.
    expect((await preview(channel, destination))[0]).toBe(cheap.sims[0]);

    await setClientList(clientToken, [
      { aliasId: await aliasOf(dear.id), priority: 1 },
      { aliasId: await aliasOf(cheap.id), priority: 2 },
    ]);
    const order = await preview(channel, destination);
    expect(order[0]).toBe(dear.sims[0]);
    // Перебор не обрывается: следующая цифра остаётся запасом, если у первой всё занято.
    expect(order).toContain(cheap.sims[0]);
  }, 120_000);

  it('одна цифра у двоих — сначала дешевле, при равных ценах — по очереди', async () => {
    const operator = await operatorId();
    const dear = await createPartner(operator, 1, '3');
    const cheap = await createPartner(operator, 1, '1');
    const twin = await createPartner(operator, 1, '1');
    const { channel, destination, clientToken } = await createChannel(operator);
    await setClientList(
      clientToken,
      await Promise.all(
        [dear, cheap, twin].map(async (partner) => ({
          aliasId: await aliasOf(partner.id),
          priority: 1,
        })),
      ),
    );

    const first = (await preview(channel, destination))[0];
    expect([cheap.sims[0], twin.sims[0]]).toContain(first);
    // Дорогой не первым, а равные по цене чередуются: следующий вызов идёт на другого.
    const second = (await preview(channel, destination))[0];
    expect([cheap.sims[0], twin.sims[0]]).toContain(second);
    expect(second).not.toBe(first);
  }, 120_000);

  it('«не использовать» исключает партнёра; кого нет в списке — идёт после названных', async () => {
    const operator = await operatorId();
    const banned = await createPartner(operator, 1, '1');
    const listed = await createPartner(operator, 1, '3');
    const unlisted = await createPartner(operator, 1, '2');
    const { channel, destination, clientToken } = await createChannel(operator);
    await setClientList(clientToken, [
      { aliasId: await aliasOf(banned.id), priority: null },
      { aliasId: await aliasOf(listed.id), priority: 1 },
    ]);

    const order = await preview(channel, destination);
    expect(order).not.toContain(banned.sims[0]);
    expect(order).toEqual([listed.sims[0], unlisted.sims[0]]);
  }, 120_000);

  it('свой список линии главнее списка клиента и остаётся закрытым', async () => {
    const operator = await operatorId();
    const first = await createPartner(operator, 1, '1');
    const second = await createPartner(operator, 1, '2');
    const { channel, destination, clientToken } = await createChannel(operator);
    await setClientList(clientToken, [
      { aliasId: await aliasOf(second.id), priority: 1 },
      { aliasId: await aliasOf(first.id), priority: 2 },
    ]);
    expect((await preview(channel, destination))[0]).toBe(second.sims[0]);

    // У линии свой список с одним партнёром: он главнее, прочие не используются.
    const put = await api().inject({
      method: 'PUT',
      url: `/channels/${channel}/partner-priorities`,
      headers: auth(),
      payload: {
        priorities: [{ aliasId: await aliasOf(first.id), terminationKind: 'sim', priority: 1 }],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(await preview(channel, destination)).toEqual([first.sims[0]]);
  }, 120_000);

  it('список звонков не видит предложений сообщений и наоборот', async () => {
    const operator = await operatorId();
    const partner = await createPartner(operator, 1);
    const { clientToken } = await createChannel(operator);
    const alias = await aliasOf(partner.id);
    expect(
      (await setClientList(clientToken, [{ aliasId: alias, offer: 'message', priority: 1 }]))
        .statusCode,
    ).toBe(400);
    expect((await setClientList(clientToken, [{ aliasId: alias, priority: 1 }])).statusCode).toBe(
      200,
    );
    const messages = await api().inject({
      method: 'GET',
      url: '/client/partner-priorities?product=messages',
      headers: bearer(clientToken),
    });
    expect(messages.json<{ priorities: unknown[] }>().priorities).toEqual([]);
  }, 120_000);
});
