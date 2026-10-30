/**
 * Лимиты по окнам (ADR-0026).
 *
 * Проверяется то, ради чего они существуют: вызов сверх квоты не совершается, а лимит
 * партнёра не мешает позвонить через другого. Это в первую очередь защита SIM партнёра —
 * оператор блокирует SIM за нечеловеческий профиль трафика, — и ошибка здесь стоит
 * партнёру его SIM.
 *
 * На реальной базе, потому что весь смысл в том, что счётчик растёт **той же
 * транзакцией**, что создаёт вызов: подставным репозиторием проверялось бы не это.
 */

import { sql } from 'drizzle-orm';
import { parseId } from '@zvonix/shared';
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
  return `79${String(600000000 + msisdnCounter).slice(0, 9)}`;
};

async function post(url: string, payload: Record<string, unknown>, headers = auth()) {
  return api().inject({ method: 'POST', url, headers, payload });
}

async function get(url: string) {
  return api().inject({ method: 'GET', url, headers: auth() });
}

async function createUser(role: 'client' | 'partner' | 'support'): Promise<string> {
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

interface Partner {
  readonly id: string;
  readonly simId: string;
}

/** Подтверждённый партнёр со шлюзом, портом, активной SIM и ценой. */
async function createPartner(operatorId: string, concurrency = 4): Promise<Partner> {
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
  // Маршрутизация выбирает только шлюзы, зарегистрированные на принявшем вызов узле.
  await registerGateway(api(), nodeKey, gateway);

  const port = (await post(`/gateways/${gateway}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;

  const sim = (
    await post('/sim-cards', { partnerId: partner, operatorId, msisdn: nextMsisdn() })
  ).json<{ sim: { id: string } }>().sim.id;
  await post(`/sim-cards/${sim}/status`, { status: 'active' });
  // Одновременность не должна подменять собой лимит: иначе проверялась бы занятость SIM.
  await post(`/sim-cards/${sim}/concurrency`, { maxConcurrentCalls: concurrency });
  await post(`/gateway-ports/${port}/sim`, { simCardId: sim });

  await post('/partner-rates', {
    partnerId: partner,
    operatorId,
    pricePerMinute: '1',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });

  return { id: partner, simId: sim };
}

interface Scenario {
  readonly operator: string;
  readonly client: string;
  readonly channel: string;
  readonly destination: string;
}

async function scenario(): Promise<Scenario> {
  const operator = (await post('/operators', { name: unique('Оператор') })).json<{
    operator: { id: string };
  }>().operator.id;

  const client = (
    await post('/clients', { ownerUserId: await createUser('client'), name: unique('Такси') })
  ).json<{ client: { id: string } }>().client.id;
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
      values (gen_random_uuid()::text::uuid, ${destination}, ${operator}, 'manual', now(), now() + interval '30 days')
    `);
  });

  return { operator, client, channel, destination };
}

interface Preview {
  outcome: string;
  reason: string | null;
  sip_response: string | null;
  candidates: { sim_card_id: string }[];
}

async function route(channel: string, destination: string, callId = unique('call')) {
  const response = await post('/routing/preview', {
    callId,
    channelId: channel,
    nodeId,
    destination,
  });
  expect(response.statusCode).toBe(201);
  return { ...response.json<Preview>(), callId };
}

async function limit(payload: Record<string, unknown>) {
  return post('/limits', payload);
}

interface LimitUsageView {
  id: string;
  usage_sim_card_id: string | null;
  resets_at: string;
  used: number;
  limit: number;
  exceeded: boolean;
  metric: string;
}

async function usage(query: string): Promise<LimitUsageView[]> {
  const response = await get(`/limits?${query}`);
  expect(response.statusCode).toBe(200);
  return response.json<{ limits: LimitUsageView[] }>().limits;
}

/** CDR ровно в том виде, в каком его шлёт `mod_json_cdr`. */
async function sendCdr(uuid: string, billsec: string) {
  return post(
    '/node/cdr',
    {
      variables: {
        uuid,
        billsec,
        hangup_cause: 'NORMAL_CLEARING',
        answer_stamp: '2026-09-03 07:15:00.000000',
        end_stamp: '2026-09-03 07:16:00.000000',
      },
    },
    asNode(),
  );
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
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('лимит звонков', () => {
  it('исчерпанный лимит клиента отклоняет вызов', async () => {
    const env = await scenario();
    await createPartner(env.operator);
    expect(
      (await limit({ clientId: env.client, window: 'day', metric: 'calls', value: 2 })).statusCode,
    ).toBe(201);

    expect((await route(env.channel, env.destination)).outcome).toBe('routed');
    expect((await route(env.channel, env.destination)).outcome).toBe('routed');

    const third = await route(env.channel, env.destination);
    expect(third.outcome).toBe('rejected');
    expect(third.reason).toBe('limit_exceeded');
    expect(third.sip_response).toBe('503 Service Unavailable');
  }, 180_000);

  it('счётчик виден в разборе и растёт вместе с вызовами', async () => {
    const env = await scenario();
    await createPartner(env.operator);
    await limit({ clientId: env.client, window: 'day', metric: 'calls', value: 5 });

    await route(env.channel, env.destination);
    await route(env.channel, env.destination);

    const [row] = await usage(`clientId=${env.client}`);
    expect(row).toMatchObject({ used: 2, limit: 5, exceeded: false });
  }, 180_000);

  it('лимит канала не трогает соседний канал того же клиента', async () => {
    const env = await scenario();
    await createPartner(env.operator);
    const second = (
      await post('/channels', {
        clientId: env.client,
        name: unique('Линия'),
        recordingRequired: false,
      })
    ).json<{ channel: { id: string } }>().channel.id;
    await post(`/channels/${second}/status`, { status: 'active' });

    await limit({ channelId: env.channel, window: 'day', metric: 'calls', value: 1 });

    expect((await route(env.channel, env.destination)).outcome).toBe('routed');
    expect((await route(env.channel, env.destination)).reason).toBe('limit_exceeded');
    // У соседнего канала своя квота — вернее, её отсутствие.
    expect((await route(second, env.destination)).outcome).toBe('routed');
  }, 180_000);
});

describe('предел одновременных разговоров линии (ADR-0101)', () => {
  it('сверх предела линия не звонит, соседняя линия и без предела звонит', async () => {
    const env = await scenario();
    // У SIM мест больше, чем разрешено линии: отказ должен прийти от линии, а не от карты.
    await createPartner(env.operator, 4);
    const second = (
      await post('/channels', {
        clientId: env.client,
        name: unique('Линия'),
        recordingRequired: false,
      })
    ).json<{ channel: { id: string } }>().channel.id;
    await post(`/channels/${second}/status`, { status: 'active' });

    const patched = await api().inject({
      method: 'PATCH',
      url: `/channels/${env.channel}`,
      headers: auth(),
      payload: { maxConcurrentCalls: 1 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ channel: { max_concurrent_calls: number } }>().channel).toMatchObject({
      max_concurrent_calls: 1,
    });

    // Первый вызов остаётся открытым (`routing`) и занимает единственное место линии.
    expect((await route(env.channel, env.destination)).outcome).toBe('routed');
    const busy = await route(env.channel, env.destination);
    expect(busy.outcome).toBe('rejected');
    expect(busy.reason).toBe('limit_exceeded');
    expect((await route(second, env.destination)).outcome).toBe('routed');
  }, 180_000);

  it('завершённый вызов место освобождает', async () => {
    const env = await scenario();
    await createPartner(env.operator, 4);
    await api().inject({
      method: 'PATCH',
      url: `/channels/${env.channel}`,
      headers: auth(),
      payload: { maxConcurrentCalls: 1 },
    });

    expect((await route(env.channel, env.destination)).outcome).toBe('routed');
    await withDatabase(async (execute) => {
      await execute(
        sql`update calls set status = 'failed', ended_at = now() where channel_id = ${env.channel}`,
      );
    });
    expect((await route(env.channel, env.destination)).outcome).toBe('routed');
  }, 180_000);
});

describe('лимит партнёра и SIM', () => {
  it('отсеивает кандидата, а не отклоняет вызов: рядом есть другой партнёр', async () => {
    // Лимит партнёра — защита его SIM, и он не должен мешать клиенту позвонить.
    const env = await scenario();
    const limited = await createPartner(env.operator);
    const free = await createPartner(env.operator);
    await limit({ simCardId: limited.simId, window: 'day', metric: 'calls', value: 1 });

    const first = await route(env.channel, env.destination);
    expect(first.outcome).toBe('routed');

    // Дальше исчерпавшая квоту SIM в кандидатах не появляется вовсе.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = await route(env.channel, env.destination);
      expect(next.outcome).toBe('routed');
      expect(next.candidates.map((candidate) => candidate.sim_card_id)).not.toContain(
        limited.simId,
      );
      expect(next.candidates[0]?.sim_card_id).toBe(free.simId);
    }
  }, 180_000);

  it('когда квоту исчерпали все, причина отличается от «нет SIM»', async () => {
    const env = await scenario();
    const only = await createPartner(env.operator);
    await limit({ partnerId: only.id, window: 'day', metric: 'calls', value: 1 });

    expect((await route(env.channel, env.destination)).outcome).toBe('routed');

    const blocked = await route(env.channel, env.destination);
    expect(blocked.outcome).toBe('rejected');
    // «Все исчерпали лимит» и «SIM нет вовсе» — разные разговоры с партнёром. И не лимит клиента: квоту исчерпал
    // партнёр, клиенту это `platform` (ADR-0107).
    expect(blocked.reason).toBe('numbers_exhausted');
  }, 180_000);
});

describe('лимит минут', () => {
  it('засчитывается по CDR и не удваивается при повторной доставке', async () => {
    const env = await scenario();
    await createPartner(env.operator);
    await limit({ clientId: env.client, window: 'day', metric: 'minutes', value: 10 });

    const call = await route(env.channel, env.destination);
    expect(call.outcome).toBe('routed');

    expect((await sendCdr(call.callId, '90')).statusCode).toBe(200);
    // Минуты копятся секундами: разговор в 90 секунд — это не «полторы минуты»
    // и не «одна», а ровно девяносто.
    expect((await usage(`clientId=${env.client}`))[0]).toMatchObject({ used: 90, limit: 600 });

    // Узел имеет право прислать CDR повторно — это штатный режим.
    expect((await sendCdr(call.callId, '90')).statusCode).toBe(200);
    expect((await usage(`clientId=${env.client}`))[0]?.used).toBe(90);
  }, 180_000);

  it('исчерпанные минуты закрывают следующий вызов', async () => {
    const env = await scenario();
    await createPartner(env.operator);
    await limit({ clientId: env.client, window: 'day', metric: 'minutes', value: 1 });

    const call = await route(env.channel, env.destination);
    await sendCdr(call.callId, '90');

    const next = await route(env.channel, env.destination);
    expect(next.reason).toBe('limit_exceeded');
  }, 180_000);
});

describe('лимит денег (ADR-0102)', () => {
  it('копится по CDR суммой списания и закрывает следующий вызов; повтор CDR не удваивает', async () => {
    const env = await scenario();
    await createPartner(env.operator);
    // Цена партнёра — 1 ₽ в минуту, наценки нет: 90 секунд — 1,50 ₽.
    expect(
      (await limit({ clientId: env.client, window: 'day', metric: 'money', value: 1 })).statusCode,
    ).toBe(201);

    const call = await route(env.channel, env.destination);
    expect(call.outcome).toBe('routed');
    await sendCdr(call.callId, '90');
    expect((await usage(`clientId=${env.client}`))[0]).toMatchObject({
      metric: 'money',
      used: 1_500_000,
      limit: 1_000_000,
      exceeded: true,
    });
    await sendCdr(call.callId, '90');
    expect((await usage(`clientId=${env.client}`))[0]?.used).toBe(1_500_000);

    expect((await route(env.channel, env.destination)).reason).toBe('limit_exceeded');
  }, 180_000);

  it('у партнёра и SIM лимита денег нет: денег на звонки они не тратят', async () => {
    const env = await scenario();
    const partner = await createPartner(env.operator);
    const refused = await limit({
      partnerId: partner.id,
      window: 'day',
      metric: 'money',
      value: 5,
    });
    expect(refused.statusCode).toBe(400);
    const sim = await limit({ simCardId: partner.simId, window: 'day', metric: 'money', value: 5 });
    expect(sim.statusCode).toBe(400);
  }, 180_000);
});

describe('часовой пояс владельца (ADR-0102)', () => {
  interface RuleView {
    id: string;
    timezone: string;
  }

  it('правило линии берёт пояс клиента; клиент без выбранного пояса — UTC', async () => {
    const env = await scenario();
    // Новый клиент — Москва по умолчанию.
    const moscow = (
      await limit({ channelId: env.channel, window: 'day', metric: 'calls', value: 5 })
    ).json<{ limit: RuleView }>().limit;
    expect(moscow.timezone).toBe('Europe/Moscow');

    // Клиент, заведённый до ADR-0102, — пояс не выбран: окна по UTC, как раньше.
    await withDatabase(async (execute) => {
      await execute(sql`update clients set timezone = null where id = ${env.client}`);
    });
    const legacy = (
      await limit({ clientId: env.client, window: 'week', metric: 'calls', value: 5 })
    ).json<{ limit: RuleView }>().limit;
    expect(legacy.timezone).toBe('UTC');
  }, 180_000);

  it('смена пояса переносит набранное в окно по новому поясу и правила линий тоже', async () => {
    const env = await scenario();
    // Мест на карте больше, чем вызовов в тесте: отказ должен прийти от лимита, а не от занятой SIM.
    await createPartner(env.operator, 8);
    await limit({ clientId: env.client, window: 'day', metric: 'calls', value: 5 });
    await limit({ channelId: env.channel, window: 'month', metric: 'calls', value: 50 });
    await route(env.channel, env.destination);
    await route(env.channel, env.destination);

    const { BillingService } = await import('../billing/billing.service.js');
    const { LimitOwnersService } = await import('../telephony/limit-owners.service.js');
    const client = await api().get(BillingService).requireClient(parseId(env.client, 'client'));
    const actor = await withDatabase(async (execute) => {
      const result = await execute(sql`select id from users where role = 'admin' limit 1`);
      return parseId((result.rows[0] as { id: string }).id, 'user');
    });
    // Камчатка: сутки начинаются на девять часов раньше московских — окно другое.
    await api()
      .get(LimitOwnersService)
      .setClientTimezone(client, 'Asia/Kamchatka', { userId: actor, role: 'admin' });

    const rows = (await get(`/limits?clientId=${env.client}`)).json<{
      limits: (LimitUsageView & { timezone: string })[];
    }>().limits;
    expect(rows[0]).toMatchObject({ timezone: 'Asia/Kamchatka', used: 2 });
    const line = (await get(`/limits?channelId=${env.channel}`)).json<{
      limits: (LimitUsageView & { timezone: string })[];
    }>().limits;
    expect(line[0]).toMatchObject({ timezone: 'Asia/Kamchatka', used: 2 });

    // Перебрать сменой пояса нельзя: третий, четвёртый и пятый проходят, шестой — нет.
    for (let i = 0; i < 3; i += 1) {
      const next = await route(env.channel, env.destination);
      expect(next.reason ?? next.outcome).toBe('routed');
    }
    expect((await route(env.channel, env.destination)).reason).toBe('limit_exceeded');
  }, 180_000);
});

describe('ведение лимитов', () => {
  it('изменение предела не трогает израсходованное', async () => {
    const env = await scenario();
    await createPartner(env.operator);
    const created = (
      await limit({ clientId: env.client, window: 'day', metric: 'calls', value: 1 })
    ).json<{ limit: { id: string } }>().limit.id;

    await route(env.channel, env.destination);
    expect((await route(env.channel, env.destination)).reason).toBe('limit_exceeded');

    // Квота изменилась — потраченное никуда не делось.
    const raised = await api().inject({
      method: 'PUT',
      url: `/limits/${created}`,
      headers: auth(),
      payload: { value: 3 },
    });
    expect(raised.statusCode).toBe(200);
    expect((await usage(`clientId=${env.client}`))[0]).toMatchObject({ used: 1, limit: 3 });
    expect((await route(env.channel, env.destination)).outcome).toBe('routed');
  }, 180_000);

  it('удаление лимита уносит счётчик: это и есть способ обнулить', async () => {
    const env = await scenario();
    await createPartner(env.operator);
    const created = (
      await limit({ clientId: env.client, window: 'day', metric: 'calls', value: 1 })
    ).json<{ limit: { id: string } }>().limit.id;

    await route(env.channel, env.destination);
    expect((await route(env.channel, env.destination)).reason).toBe('limit_exceeded');

    const removed = await api().inject({
      method: 'DELETE',
      url: `/limits/${created}`,
      headers: auth(),
    });
    expect(removed.statusCode).toBe(200);
    expect(await usage(`clientId=${env.client}`)).toHaveLength(0);

    await limit({ clientId: env.client, window: 'day', metric: 'calls', value: 1 });
    expect((await route(env.channel, env.destination)).outcome).toBe('routed');
  }, 180_000);

  it('лимит принадлежит ровно одному субъекту', async () => {
    const env = await scenario();
    expect((await limit({ window: 'day', metric: 'calls', value: 1 })).statusCode).toBe(400);
    expect(
      (
        await limit({
          clientId: env.client,
          channelId: env.channel,
          window: 'day',
          metric: 'calls',
          value: 1,
        })
      ).statusCode,
    ).toBe(400);
  }, 180_000);

  it('два одинаковых окна с одной метрикой у субъекта не заводятся', async () => {
    const env = await scenario();
    expect(
      (await limit({ clientId: env.client, window: 'day', metric: 'calls', value: 1 })).statusCode,
    ).toBe(201);
    expect(
      (await limit({ clientId: env.client, window: 'day', metric: 'calls', value: 5 })).statusCode,
    ).toBe(409);
    // Другая метрика и другое окно — это другие лимиты, они уживаются.
    expect(
      (await limit({ clientId: env.client, window: 'day', metric: 'minutes', value: 5 }))
        .statusCode,
    ).toBe(201);
    expect(
      (await limit({ clientId: env.client, window: 'hour', metric: 'calls', value: 5 })).statusCode,
    ).toBe(201);
  }, 180_000);

  it('поддержка видит лимиты, но не заводит', async () => {
    const email = uniqueEmail();
    const { IdentityService } = await import('../identity/identity.service.js');
    await api().get(IdentityService).createByAdmin({
      email,
      password: TEST_PASSWORD,
      fullName: 'Поддержка',
      role: 'support',
      status: 'active',
    });
    const login = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
    });
    const headers = { authorization: `Bearer ${login.json<{ token: string }>().token}` };

    expect((await api().inject({ method: 'GET', url: '/limits', headers })).statusCode).toBe(200);

    const created = await api().inject({
      method: 'POST',
      url: '/limits',
      headers,
      payload: { clientId: (await scenario()).client, window: 'day', metric: 'calls', value: 1 },
    });
    expect(created.statusCode).toBe(403);
  }, 180_000);
});

/** Вторая карта того же партнёра — своим шлюзом, как у партнёров с несколькими GOIP. */
async function addSim(partnerId: string, operatorId: string): Promise<string> {
  const gateway = (
    await post('/gateways', { partnerId, name: unique('Шлюз'), type: 'goip' })
  ).json<{ gateway: { id: string } }>().gateway.id;
  await post(`/gateways/${gateway}/status`, { status: 'active' });
  await registerGateway(api(), nodeKey, gateway);
  const port = (await post(`/gateways/${gateway}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;
  const sim = (await post('/sim-cards', { partnerId, operatorId, msisdn: nextMsisdn() })).json<{
    sim: { id: string };
  }>().sim.id;
  await post(`/sim-cards/${sim}/status`, { status: 'active' });
  await post(`/sim-cards/${sim}/concurrency`, { maxConcurrentCalls: 4 });
  await post(`/gateway-ports/${port}/sim`, { simCardId: sim });
  return sim;
}

describe('лимит «на каждую карту» (ADR-0057)', () => {
  it('исчерпанная карта уходит из перебора, соседняя того же партнёра звонит дальше', async () => {
    const env = await scenario();
    const partner = await createPartner(env.operator);
    const second = await addSim(partner.id, env.operator);
    expect(
      (
        await limit({
          partnerId: partner.id,
          perSim: true,
          window: 'day',
          metric: 'calls',
          value: 1,
        })
      ).statusCode,
    ).toBe(201);

    const first = await route(env.channel, env.destination);
    const next = await route(env.channel, env.destination);
    expect(`${first.outcome}:${String(first.reason)}`).toBe('routed:null');
    expect(`${next.outcome}:${String(next.reason)}`).toBe('routed:null');
    // По звонку на каждую карту: одно правило, свой счётчик у каждой SIM.
    expect(new Set([first.candidates[0]?.sim_card_id, next.candidates[0]?.sim_card_id])).toEqual(
      new Set([partner.simId, second]),
    );

    const blocked = await route(env.channel, env.destination);
    expect(blocked.reason).toBe('numbers_exhausted');

    const rows = await usage(`partnerId=${partner.id}`);
    expect(rows.map((row) => row.usage_sim_card_id).sort()).toEqual([partner.simId, second].sort());
    expect(rows.every((row) => row.used === 1 && row.exceeded)).toBe(true);
  }, 180_000);

  it('пакет минут поминутно: 61 секунда — две минуты пакета', async () => {
    const env = await scenario();
    const partner = await createPartner(env.operator);
    expect(
      (
        await limit({
          partnerId: partner.id,
          perSim: true,
          window: 'month',
          periodStartDay: 15,
          metric: 'minutes',
          rounding: 'minute',
          value: 100,
        })
      ).statusCode,
    ).toBe(201);

    const call = await route(env.channel, env.destination);
    expect((await sendCdr(call.callId, '61')).statusCode).toBe(200);

    const [row] = await usage(`partnerId=${partner.id}`);
    expect(row).toMatchObject({ usage_sim_card_id: partner.simId, used: 120, limit: 6000 });
    // Окно обнуляется 15-го, а не первого числа.
    // Новый партнёр считает по Москве (ADR-0102): 15-е наступает в 00:00 МСК — по UTC это ещё 14-е.
    expect(
      new Date(row?.resets_at ?? '').toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }),
    ).toMatch(/-15$/u);
  }, 180_000);

  it('несогласованное правило отвергается внятно, а не ошибкой базы', async () => {
    const env = await scenario();
    const partner = await createPartner(env.operator);
    const refusals = await Promise.all([
      limit({ clientId: env.client, perSim: true, window: 'day', metric: 'calls', value: 5 }),
      limit({
        partnerId: partner.id,
        window: 'day',
        metric: 'calls',
        rounding: 'minute',
        value: 5,
      }),
      limit({ partnerId: partner.id, window: 'day', metric: 'calls', periodStartDay: 3, value: 5 }),
    ]);
    expect(refusals.map((response) => response.statusCode)).toEqual([400, 400, 400]);
  }, 180_000);

  it('минутное окно ловит частые звонки с одной карты', async () => {
    const env = await scenario();
    const partner = await createPartner(env.operator);
    await limit({ simCardId: partner.simId, window: 'minute', metric: 'calls', value: 1 });

    expect((await route(env.channel, env.destination)).outcome).toBe('routed');
    expect((await route(env.channel, env.destination)).reason).toBe('numbers_exhausted');
  }, 180_000);
});
