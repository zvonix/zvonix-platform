/**
 * Приём CDR на реальной базе (ADR-0010).
 *
 * Замыкает цепочку этапа 2: маршрут → резерв → разговор → списание. Проверяется то,
 * что стоит денег: повторная доставка не списывает дважды, несостоявшийся разговор
 * освобождает резерв, а сумма трёх проводок равна нулю.
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
const asNode = () => ({ authorization: `Bearer ${nodeKey}` });

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

let msisdnCounter = 0;
const nextMsisdn = (): string => {
  msisdnCounter += 1;
  return `79${String(300000000 + msisdnCounter).slice(0, 9)}`;
};

async function post(url: string, payload: Record<string, unknown>, headers = auth()) {
  return api().inject({ method: 'POST', url, headers, payload });
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

/** Готовая цепочка: партнёр со шлюзом и SIM, клиент с деньгами, каналом и тарифом. */
async function scenario(options: { pricePerMinute?: string; commissionBp?: number } = {}) {
  const operator = (await post('/operators', { name: unique('Оператор') })).json<{
    operator: { id: string };
  }>().operator.id;

  const partner = (
    await post('/partners', {
      ownerUserId: await createUser('partner'),
      name: 'Иванов Иван',
      displayName: unique('Партнёр'),
    })
  ).json<{ partner: { id: string } }>().partner.id;

  const client = (
    await post('/clients', { ownerUserId: await createUser('client'), name: unique('Такси') })
  ).json<{ client: { id: string } }>().client.id;

  await withDatabase(async (execute) => {
    await execute(sql`update partners set status = 'verified' where id = ${partner}`);
    await execute(sql`update clients set status = 'active' where id = ${client}`);
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
    await post('/sim-cards', { partnerId: partner, operatorId: operator, msisdn: nextMsisdn() })
  ).json<{ sim: { id: string } }>().sim.id;
  await post(`/sim-cards/${sim}/status`, { status: 'active' });
  await post(`/gateway-ports/${port}/sim`, { simCardId: sim });

  const channel = (await post('/channels', { clientId: client, name: unique('Линия') })).json<{
    channel: { id: string };
  }>().channel.id;
  await post(`/channels/${channel}/status`, { status: 'active' });

  await post('/partner-rates', {
    partnerId: partner,
    operatorId: operator,
    pricePerMinute: options.pricePerMinute ?? '10',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  await post('/commission-rules', {
    clientId: client,
    percentBasisPoints: options.commissionBp ?? 1500,
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
      values (gen_random_uuid()::text::uuid, ${destination}, ${operator}, 'manual', now(), now() + interval '30 days')
    `);
  });

  return { operator, partner, client, sim, channel, destination, gateway };
}

interface Preview {
  outcome: string;
  call_id: string | null;
}

/** Проводит вызов через маршрутизацию и возвращает его идентификатор на узле. */
async function startCall(channel: string, destination: string): Promise<string> {
  const externalId = unique('uuid');
  const response = await post('/routing/preview', {
    callId: externalId,
    channelId: channel,
    nodeId,
    destination,
  });
  expect(response.json<Preview>().outcome).toBe('routed');
  return externalId;
}

/** CDR ровно в том виде, в каком его шлёт `mod_json_cdr`. */
async function sendCdr(
  uuid: string,
  overrides: Record<string, unknown> = {},
): Promise<ReturnType<typeof post> extends Promise<infer T> ? T : never> {
  return post(
    '/node/cdr',
    {
      variables: {
        uuid,
        billsec: '60',
        hangup_cause: 'NORMAL_CLEARING',
        answer_stamp: '2026-09-02 07:15:00.000000',
        end_stamp: '2026-09-02 07:16:00.000000',
        ...overrides,
      },
    },
    asNode(),
  );
}

async function balance(clientId: string): Promise<bigint> {
  return withDatabase(async (execute) => {
    const result = await execute(
      sql`select balance::text as balance from accounts where kind = 'client' and owner_id = ${clientId}`,
    );
    return BigInt((result.rows[0] as { balance: string }).balance);
  });
}

async function heldTotal(clientId: string): Promise<bigint> {
  return withDatabase(async (execute) => {
    const result = await execute(
      sql`select coalesce(sum(amount), 0)::text as total from reservations
           where client_id = ${clientId} and status = 'held'`,
    );
    return BigInt((result.rows[0] as { total: string }).total);
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
});

afterAll(async () => {
  await app?.close();
});

describe('состоявшийся разговор', () => {
  it('списывается по тарифу, резерв закрывается, место на SIM освобождается', async () => {
    const env = await scenario({ pricePerMinute: '10', commissionBp: 1500 });
    const before = await balance(env.client);
    const uuid = await startCall(env.channel, env.destination);

    // Резерв придержан на час разговора: 10 ₽/мин × 60 + 15% = 690 ₽.
    expect(await heldTotal(env.client)).toBe(690_000_000n);

    const response = await sendCdr(uuid, { billsec: '60' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ outcome: string }>().outcome).toBe('charged');

    // Минута по 10 ₽ плюс 15% наценки = 11,50 ₽.
    expect(before - (await balance(env.client))).toBe(11_500_000n);
    expect(await heldTotal(env.client)).toBe(0n);

    // Место на SIM свободно: следующий вызов проходит.
    const next = await post('/routing/preview', {
      callId: unique('uuid'),
      channelId: env.channel,
      nodeId,
      destination: env.destination,
    });
    expect(next.json<Preview>().outcome).toBe('routed');
  });

  it('сумма трёх проводок равна нулю', async () => {
    const env = await scenario();
    const uuid = await startCall(env.channel, env.destination);
    await sendCdr(uuid);

    const total = await withDatabase(async (execute) => {
      const result = await execute(sql`
        select coalesce(sum(e.amount), 0)::text as total
          from ledger_entries e
          join ledger_transactions t on t.id = e.transaction_id
          join calls c on c.id::text = t.reference_id
         where c.external_id = ${uuid} and t.kind = 'charge'
      `);
      return BigInt((result.rows[0] as { total: string }).total);
    });
    // Деньги не возникают и не исчезают: клиент платит ровно то, что получают
    // партнёр и платформа.
    expect(total).toBe(0n);
  });

  it('партнёр получает свою долю, платформа — наценку', async () => {
    const env = await scenario({ pricePerMinute: '10', commissionBp: 1500 });
    const uuid = await startCall(env.channel, env.destination);
    await sendCdr(uuid, { billsec: '60' });

    const partnerBalance = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select balance::text as balance from accounts where kind = 'partner' and owner_id = ${env.partner}`,
      );
      return BigInt((result.rows[0] as { balance: string }).balance);
    });
    expect(partnerBalance).toBe(10_000_000n);

    const revenue = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select balance::text as balance from accounts where kind = 'revenue'`,
      );
      return BigInt((result.rows[0] as { balance: string }).balance);
    });
    expect(revenue).toBeGreaterThanOrEqual(1_500_000n);
  });
});

describe('идемпотентность', () => {
  it('повторная доставка не списывает дважды', async () => {
    const env = await scenario();
    const before = await balance(env.client);
    const uuid = await startCall(env.channel, env.destination);

    expect((await sendCdr(uuid)).statusCode).toBe(200);
    const afterFirst = await balance(env.client);

    // Узел повторяет CDR при неудаче доставки — это штатный режим, а не сбой.
    expect((await sendCdr(uuid)).statusCode).toBe(200);
    expect((await sendCdr(uuid)).statusCode).toBe(200);

    expect(await balance(env.client)).toBe(afterFirst);
    expect(before - afterFirst).toBeGreaterThan(0n);

    // Считаем проводки **этого** вызова: база у проверок в файле общая.
    const transactions = await withDatabase(async (execute) => {
      const result = await execute(sql`
        select count(*)::int as n
          from ledger_transactions t
          join calls c on c.id::text = t.reference_id
         where c.external_id = ${uuid} and t.kind = 'charge'
      `);
      return (result.rows[0] as { n: number }).n;
    });
    expect(transactions).toBe(1);
  });

  it('одновременная доставка одного CDR тоже даёт одно списание', async () => {
    const env = await scenario();
    const before = await balance(env.client);
    const uuid = await startCall(env.channel, env.destination);

    await Promise.all([sendCdr(uuid), sendCdr(uuid), sendCdr(uuid)]);

    const charged = before - (await balance(env.client));
    expect(charged).toBe(11_500_000n);
  });
});

describe('несостоявшийся разговор', () => {
  it.each([
    ['занято', 'USER_BUSY', 'busy'],
    ['не ответили', 'NO_ANSWER', 'no_answer'],
    ['отменён', 'ORIGINATOR_CANCEL', 'cancelled'],
  ])('%s: резерв освобождается, денег не движется', async (_name, cause, expected) => {
    const env = await scenario();
    const before = await balance(env.client);
    const uuid = await startCall(env.channel, env.destination);

    const response = await sendCdr(uuid, {
      billsec: '0',
      hangup_cause: cause,
      answer_stamp: '0000-00-00 00:00:00',
    });
    expect(response.json<{ outcome: string }>().outcome).toBe('closed');

    expect(await balance(env.client)).toBe(before);
    expect(await heldTotal(env.client)).toBe(0n);

    const stored = await withDatabase(async (execute) => {
      const result = await execute(sql`select status from calls where external_id = ${uuid}`);
      return (result.rows[0] as { status: string }).status;
    });
    expect(stored).toBe(expected);
  });
});

describe('поведение узла задаётся кодом ответа', () => {
  it('неразбираемое тело — 400: повторять бессмысленно, но человек обязан увидеть', async () => {
    const response = await post('/node/cdr', { чушь: true }, asNode());
    expect(response.statusCode).toBe(400);
  });

  it('CDR по неизвестному вызову — 404, а не тихое согласие', async () => {
    const response = await sendCdr('вызова-такого-нет');
    expect(response.statusCode).toBe(404);
  });

  it('плечо B принимается без тарификации', async () => {
    const env = await scenario();
    const before = await balance(env.client);
    const uuid = await startCall(env.channel, env.destination);

    const callId = await withDatabase(async (execute) => {
      const result = await execute(sql`select id from calls where external_id = ${uuid}`);
      return (result.rows[0] as { id: string }).id;
    });

    // У плеча B свой uuid, но наш идентификатор вызова экспортирован на оба.
    // Тарифицировать его нельзя: это тот же разговор, списание вышло бы двойным.
    const response = await sendCdr(unique('b-leg'), { zvonix_call_id: callId });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ outcome: string }>().outcome).toBe('ignored_b_leg');
    expect(await balance(env.client)).toBe(before);
  });

  it('без ключа узла CDR не принимается', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/node/cdr',
      payload: { variables: { uuid: 'x' } },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('разбор для поддержки', () => {
  it('вызовы канала видны вместе с отказами и причинами', async () => {
    const env = await scenario();
    const uuid = await startCall(env.channel, env.destination);
    await sendCdr(uuid);
    // Отказ по неподтверждённому оператору — тоже вызов.
    await post('/routing/preview', {
      callId: unique('uuid'),
      channelId: env.channel,
      nodeId,
      destination: '79997776655',
    });

    const listed = await api().inject({
      method: 'GET',
      url: `/channels/${env.channel}/calls`,
      headers: auth(),
    });
    expect(listed.statusCode).toBe(200);

    const calls = listed.json<{ calls: { status: string; failure_reason: string | null }[] }>()
      .calls;
    expect(calls.some((call) => call.status === 'completed')).toBe(true);
    expect(calls.some((call) => call.failure_reason === 'operator_unconfirmed')).toBe(true);
  });
});
