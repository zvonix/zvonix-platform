/**
 * Клиентский контур на реальной базе.
 *
 * Здесь проверяется не удобство, а **граница**: клиент видит только своё, партнёра
 * не видит ни в каком виде ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)),
 * а причина отказа приходит переведённой — по внутренней читалась бы ёмкость площадки.
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
const as = (bearer: string) => ({ authorization: `Bearer ${bearer}` });

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

let msisdnCounter = 0;
const nextMsisdn = (): string => {
  msisdnCounter += 1;
  return `7940${String(1000000 + msisdnCounter)}`;
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

interface ClientCall {
  id: string;
  destination: string;
  status: string;
  failure_reason: string | null;
  duration_seconds: number | null;
  channel: { id: string; name: string };
  operator: { id: string; name: string } | null;
}

interface Account {
  client: { id: string; name: string; status: string };
  funds: { balance: string; overdraft_limit: string; held: string; available: string };
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

/** Учётная запись клиента вместе с её токеном: кабинет открывает она, а не админ. */
async function createClientUser(): Promise<{ userId: string; token: string }> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  const created = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Диспетчер',
    role: 'client',
    status: 'active',
  });
  return { userId: created.id, token: await login(email) };
}

async function resolveNumber(destination: string, operator: string): Promise<void> {
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into number_resolutions (id, msisdn, operator_id, source, resolved_at, expires_at)
      values (gen_random_uuid()::text::uuid, ${destination}, ${operator}, 'manual', now(), now() + interval '30 days')
    `);
  });
}

/** Клиент вместе с активным каналом. Правило наценки и деньги — по требованию. */
async function createClient(options: { commission: boolean; deposit: boolean }) {
  const owner = await createClientUser();
  const id = (await post('/clients', { ownerUserId: owner.userId, name: unique('Такси') })).json<{
    client: { id: string };
  }>().client.id;
  expect((await patch(`/clients/${id}/status`, { status: 'active' })).statusCode).toBe(200);

  const channel = (await post('/channels', { clientId: id, name: unique('Линия') })).json<{
    channel: { id: string };
  }>().channel.id;
  await post(`/channels/${channel}/status`, { status: 'active' });

  if (options.commission) {
    await post('/commission-rules', {
      clientId: id,
      percentBasisPoints: 1500,
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
  }
  if (options.deposit) {
    await post(`/clients/${id}/deposit`, {
      amount: '10000',
      idempotencyKey: unique('deposit'),
      description: 'Пополнение под проверку',
    });
  }

  return { id, channel, token: owner.token, userId: owner.userId };
}

let operatorId = '';
let operatorName = '';
let partnerName = '';
let partnerId = '';
let rich: Awaited<ReturnType<typeof createClient>>;
let poor: Awaited<ReturnType<typeof createClient>>;
let untariffed: Awaited<ReturnType<typeof createClient>>;
const numbers = { rich: '', poor: '', untariffed: '' };

async function route(channel: string, destination: string): Promise<string> {
  const callId = unique('uuid');
  const response = await post('/routing/preview', {
    callId,
    channelId: channel,
    nodeId,
    destination,
  });
  return response.json<{ outcome: string; reason: string | null }>().reason ?? 'routed';
}

async function buildScenario(): Promise<void> {
  operatorName = unique('Оператор');
  operatorId = (await post('/operators', { name: operatorName })).json<{
    operator: { id: string };
  }>().operator.id;

  partnerName = 'Петров Пётр';
  partnerId = (
    await post('/partners', {
      ownerUserId: await createUser('partner'),
      name: partnerName,
      displayName: unique('Партнёр'),
    })
  ).json<{ partner: { id: string } }>().partner.id;
  await patch(`/partners/${partnerId}/status`, { status: 'verified' });

  const gateway = (
    await post('/gateways', { partnerId, name: unique('Шлюз'), type: 'goip' })
  ).json<{ gateway: { id: string } }>().gateway.id;
  await post(`/gateways/${gateway}/status`, { status: 'active' });
  // Маршрутизация выбирает только шлюзы, зарегистрированные на принявшем вызов узле.
  await registerGateway(api(), nodeKey, gateway);

  const port = (await post(`/gateways/${gateway}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;
  const sim = (await post('/sim-cards', { partnerId, operatorId, msisdn: nextMsisdn() })).json<{
    sim: { id: string };
  }>().sim.id;
  await post(`/sim-cards/${sim}/status`, { status: 'active' });
  await post(`/gateway-ports/${port}/sim`, { simCardId: sim });

  await post('/partner-rates', {
    partnerId,
    operatorId,
    pricePerMinute: '10',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });

  rich = await createClient({ commission: true, deposit: true });
  poor = await createClient({ commission: true, deposit: false });
  untariffed = await createClient({ commission: false, deposit: true });

  numbers.rich = nextMsisdn();
  numbers.poor = nextMsisdn();
  numbers.untariffed = nextMsisdn();
  await resolveNumber(numbers.rich, operatorId);
  await resolveNumber(numbers.poor, operatorId);
  await resolveNumber(numbers.untariffed, operatorId);

  // Состоявшийся разговор у клиента с деньгами.
  const uuid = unique('uuid');
  expect(
    (
      await post('/routing/preview', {
        callId: uuid,
        channelId: rich.channel,
        nodeId,
        destination: numbers.rich,
      })
    ).json<{ outcome: string }>().outcome,
  ).toBe('routed');
  expect(
    (
      await post(
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
        as(nodeKey),
      )
    ).statusCode,
  ).toBe(200);

  // Отказ, адресованный самому клиенту, и отказ на нашей стороне.
  expect(await route(poor.channel, numbers.poor)).toBe('insufficient_funds');
  expect(await route(untariffed.channel, numbers.untariffed)).toBe('no_tariff');
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

  await buildScenario();
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('свой счёт', () => {
  it('отдаёт клиента и деньги вместе: остатка одного мало', async () => {
    const response = await get('/client/account', as(rich.token));
    expect(response.statusCode).toBe(200);

    const account = response.json<Account>();
    expect(account.client.id).toBe(rich.id);
    expect(account.client.status).toBe('active');
    // Пополнено 10 000, списано 11,50 за минуту разговора.
    // Дробная часть без хвостовых нулей: 'Money.format' их снимает.
    expect(account.funds.balance).toBe('9988.5');
    expect(account.funds.held).toBe('0');
    expect(account.funds.available).toBe('9988.5');
  }, 120_000);

  it('у клиента без денег доступного нет, и это видно ему самому', async () => {
    const account = (await get('/client/account', as(poor.token))).json<Account>();
    expect(account.funds.balance).toBe('0');
    expect(account.funds.available).toBe('0');
  }, 120_000);

  it('движение денег своё: видно, что произошло, а не только сумма', async () => {
    const response = await get('/client/entries', as(rich.token));
    expect(response.statusCode).toBe(200);

    const entries = response.json<{
      entries: { kind: string; amount: string; description: string }[];
      total: number;
    }>();
    expect(entries.total).toBe(2);
    expect(entries.entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(['deposit', 'charge']),
    );
  }, 120_000);
});

describe('свои линии', () => {
  it('перечисляются — до этого обработчика взять их идентификаторы было неоткуда', async () => {
    const response = await get('/client/channels', as(rich.token));
    expect(response.statusCode).toBe(200);

    const channels = response.json<{ channels: { id: string; status: string }[] }>().channels;
    expect(channels).toHaveLength(1);
    expect(channels[0]?.id).toBe(rich.channel);
    expect(channels[0]?.status).toBe('active');
  }, 120_000);

  it('чужие не показываются', async () => {
    const channels = (await get('/client/channels', as(poor.token))).json<{
      channels: { id: string }[];
    }>().channels;
    expect(channels.map((channel) => channel.id)).not.toContain(rich.channel);
  }, 120_000);

  it('по своему каналу клиент задаёт порядок партнёров сам', async () => {
    const aliases = (await get('/partner-aliases', as(rich.token))).json<{
      partners: { alias_id: string }[];
    }>().partners;
    expect(aliases.length).toBeGreaterThan(0);

    const saved = await api().inject({
      method: 'PUT',
      url: `/channels/${rich.channel}/partner-priorities`,
      headers: as(rich.token),
      payload: { priorities: [{ aliasId: aliases[0]?.alias_id, priority: 1 }] },
    });
    expect(saved.statusCode).toBe(200);
  }, 120_000);

  it('чужой канал для клиента не существует', async () => {
    const response = await get(`/channels/${rich.channel}/allowed-operators`, as(poor.token));
    // `404`, а не `403`: по разнице ответов перебирались бы чужие идентификаторы.
    expect(response.statusCode).toBe(404);
  }, 120_000);
});

describe('свои вызовы', () => {
  it('приходят без партнёра, шлюза и SIM — ни в каком виде', async () => {
    const response = await get('/client/calls', as(rich.token));
    expect(response.statusCode).toBe(200);

    const body = response.body;
    expect(body).not.toContain('partner');
    expect(body).not.toContain('gateway');
    expect(body).not.toContain('sim');
    expect(body).not.toContain(partnerName);

    const calls = response.json<{ calls: ClientCall[]; total: number }>();
    expect(calls.total).toBe(1);
    expect(calls.calls[0]?.status).toBe('completed');
    expect(calls.calls[0]?.duration_seconds).toBe(60);
    expect(calls.calls[0]?.operator?.name).toBe(operatorName);
    expect(calls.calls[0]?.channel.id).toBe(rich.channel);
  }, 120_000);

  it('чужих вызовов в списке нет', async () => {
    const calls = (await get('/client/calls', as(poor.token))).json<{ calls: ClientCall[] }>()
      .calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.destination).toBe(numbers.poor);
  }, 120_000);

  it('причина, адресованная клиенту, приходит как есть', async () => {
    const calls = (await get('/client/calls', as(poor.token))).json<{ calls: ClientCall[] }>()
      .calls;
    expect(calls[0]?.failure_reason).toBe('insufficient_funds');
  }, 120_000);

  it('причина с нашей стороны не называется: по ней читалась бы ёмкость площадки', async () => {
    const calls = (await get('/client/calls', as(untariffed.token))).json<{ calls: ClientCall[] }>()
      .calls;
    expect(calls[0]?.failure_reason).toBe('platform');
    expect(calls[0]?.failure_reason).not.toBe('no_tariff');
  }, 120_000);

  it('отбирает по своему каналу', async () => {
    const calls = (await get(`/client/calls?channelId=${rich.channel}`, as(rich.token))).json<{
      total: number;
    }>();
    expect(calls.total).toBe(1);
  }, 120_000);

  it('чужой канал в отборе не показывает чужого: рядом стоит отбор по клиенту', async () => {
    const calls = (await get(`/client/calls?channelId=${rich.channel}`, as(poor.token))).json<{
      total: number;
    }>();
    expect(calls.total).toBe(0);
  }, 120_000);
});

describe('свои цены', () => {
  it('показывают предложения партнёров с ценой клиента, а не тарифом партнёра', async () => {
    const response = await get('/client/prices', as(rich.token));
    expect(response.statusCode).toBe(200);

    const offers = response.json<{
      offers: {
        alias_id: string;
        display_name: string;
        termination_kind: string;
        min_price: string;
        max_price: string;
        directions: number;
      }[];
    }>().offers;

    expect(offers).toHaveLength(1);
    // Тариф партнёра — 10 ₽ за минуту, наценка клиента — 15 %. Показывается то,
    // что заплатит клиент, а не то, что получит партнёр.
    expect(offers[0]?.min_price).toBe('11.5');
    expect(offers[0]?.max_price).toBe('11.5');
    expect(offers[0]?.termination_kind).toBe('sim');
    expect(offers[0]?.directions).toBe(1);
  }, 120_000);

  it('партнёр назван только псевдонимом', async () => {
    const response = await get('/client/prices', as(rich.token));
    expect(response.body).not.toContain(partnerName);
    expect(response.json<{ offers: { display_name: string }[] }>().offers[0]?.display_name).toMatch(
      /^Партнёр-/u,
    );
  }, 120_000);

  it('сужаются оператором', async () => {
    const other = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;

    const narrowed = await get(`/client/prices?operatorId=${other}`, as(rich.token));
    // По этому оператору цен нет ни у кого — предложений тоже нет.
    expect(narrowed.json<{ offers: unknown[] }>().offers).toHaveLength(0);
  }, 120_000);
});

describe('состав цены', () => {
  it('показывает шаг, минимум, плату за соединение и стоимость коротких вызовов', async () => {
    const response = await get('/client/tariffs', as(rich.token));
    expect(response.statusCode).toBe(200);

    const rows = response.json<{
      tariffs: {
        display_name: string;
        billing_increment_seconds: number;
        minimum_duration_seconds: number;
        price_per_minute: string;
        connection_fee: string;
        examples: { seconds: number; amount: string }[];
      }[];
    }>().tariffs;

    expect(rows).toHaveLength(1);
    const tariff = rows[0];
    // Тариф партнёра — 10 ₽ за минуту посекундно, наценка клиента — 15 %.
    expect(tariff?.billing_increment_seconds).toBe(1);
    expect(tariff?.minimum_duration_seconds).toBe(0);
    expect(tariff?.price_per_minute).toBe('11.5');
    expect(tariff?.connection_fee).toBe('0');
    expect(tariff?.examples.map((example) => example.seconds)).toEqual([15, 30, 60]);
    // Посекундно: четверть минуты стоит четверть цены.
    expect(tariff?.examples[0]?.amount).toBe('2.875');
    expect(tariff?.examples[2]?.amount).toBe('11.5');
  }, 120_000);

  it('поминутный тариф на коротком вызове стоит вчетверо дороже посекундного', async () => {
    // Тот же партнёр, то же направление — но цена задана заново, шагом в минуту.
    // Действует последняя, поэтому проверка идёт по ней.
    const later = new Date(Date.now() + 1000).toISOString();
    expect(
      (
        await post('/partner-rates', {
          partnerId: partnerId,
          operatorId,
          pricePerMinute: '10',
          billingIncrementSeconds: 60,
          effectiveFrom: later,
        })
      ).statusCode,
    ).toBe(201);

    // Ждать нечего: цена действует с момента в прошлом относительно запроса.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const rows = (await get('/client/tariffs', as(rich.token))).json<{
      tariffs: { billing_increment_seconds: number; examples: { amount: string }[] }[];
    }>().tariffs;

    const minutely = rows.find((row) => row.billing_increment_seconds === 60);
    // Пятнадцать секунд оплачиваются как полная минута: 11,50 ₽ вместо 2,875 ₽.
    expect(minutely?.examples[0]?.amount).toBe('11.5');
  }, 120_000);

  it('цена в списке предложений считается на названной длительности', async () => {
    const short = await get('/client/prices?seconds=15', as(rich.token));
    expect(short.json<{ seconds: number }>().seconds).toBe(15);

    const long = await get('/client/prices?seconds=60', as(rich.token));
    expect(long.json<{ seconds: number }>().seconds).toBe(60);

    // Тариф теперь поминутный: пятнадцать секунд стоят столько же, сколько минута.
    const shortPrice = short.json<{ offers: { min_price: string }[] }>().offers[0]?.min_price;
    const longPrice = long.json<{ offers: { min_price: string }[] }>().offers[0]?.min_price;
    expect(shortPrice).toBe(longPrice);
  }, 120_000);

  it('негодная длительность даёт умолчание, а не отказ', async () => {
    const response = await get('/client/prices?seconds=нисколько', as(rich.token));
    expect(response.statusCode).toBe(200);
    expect(response.json<{ seconds: number }>().seconds).toBe(60);
  }, 120_000);
});

describe('доступ', () => {
  it('администратору клиентский контур закрыт: у него свои разделы', async () => {
    expect((await get('/client/account')).statusCode).toBe(403);
    expect((await get('/client/channels')).statusCode).toBe(403);
    expect((await get('/client/calls')).statusCode).toBe(403);
    expect((await get('/client/entries')).statusCode).toBe(403);
    expect((await get('/client/prices')).statusCode).toBe(403);
    expect((await get('/client/tariffs')).statusCode).toBe(403);
  }, 120_000);

  it('учётной записи без клиента отвечает 404, а не пустотой', async () => {
    const orphan = await createClientUser();
    expect((await get('/client/account', as(orphan.token))).statusCode).toBe(404);
    expect((await get('/client/channels', as(orphan.token))).statusCode).toBe(404);
  }, 120_000);

  it('без входа не отдаётся ничего', async () => {
    const response = await api().inject({ method: 'GET', url: '/client/account' });
    expect(response.statusCode).toBe(401);
  }, 120_000);
});
