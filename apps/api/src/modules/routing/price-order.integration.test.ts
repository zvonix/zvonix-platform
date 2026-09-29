/**
 * Порядок терминации по цене
 * ([ADR-0040](../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)).
 *
 * Главная проверка здесь — третья: партнёр, дешёвый на одном операторе и дорогой
 * на другом, встаёт первым там и последним тут **без единой настройки у клиента**.
 * Списком приоритетов это невыразимо: список один на все направления.
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

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

let msisdnCounter = 0;
const nextMsisdn = (): string => {
  msisdnCounter += 1;
  return `7950${String(1000000 + msisdnCounter)}`;
};

async function post(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url, headers: auth(), payload });
}

async function patch(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'PATCH', url, headers: auth(), payload });
}

interface Partner {
  readonly id: string;
  readonly aliasId: string;
  readonly simId: string;
}

/** Партнёр с одной SIM нужного оператора и запасом одновременности. */
async function createPartner(operatorId: string): Promise<Partner> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const owner = await api().get(IdentityService).createByAdmin({
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    fullName: 'Владелец',
    role: 'partner',
    status: 'active',
  });

  const displayName = unique('Партнёр');
  const id = (
    await post('/partners', { ownerUserId: owner.id, name: unique('Иванов'), displayName })
  ).json<{ partner: { id: string } }>().partner.id;
  await patch(`/partners/${id}/status`, { status: 'verified' });

  const gateway = (
    await post('/gateways', { partnerId: id, name: unique('Шлюз'), type: 'goip' })
  ).json<{ gateway: { id: string } }>().gateway.id;
  await post(`/gateways/${gateway}/status`, { status: 'active' });
  // Маршрутизация выбирает только шлюзы, зарегистрированные на принявшем вызов узле.
  await registerGateway(api(), nodeKey, gateway);

  const port = (await post(`/gateways/${gateway}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;
  const simId = (
    await post('/sim-cards', { partnerId: id, operatorId, msisdn: nextMsisdn() })
  ).json<{ sim: { id: string } }>().sim.id;
  await post(`/sim-cards/${simId}/status`, { status: 'active' });
  // Запас одновременности: проверки идут подряд, а разбор вызова их не закрывает.
  // Значение проверяется: предел площадки равен восьми, и молча отвергнутый запрос
  // оставил бы единицу — тогда второй вызов уходил бы к другому партнёру, и проверка
  // цены доказывала бы не то, что проверяет.
  expect(
    (await post(`/sim-cards/${simId}/concurrency`, { maxConcurrentCalls: 8 })).statusCode,
  ).toBe(201);
  await post(`/gateway-ports/${port}/sim`, { simCardId: simId });

  const aliases = (
    await api().inject({ method: 'GET', url: '/partner-aliases', headers: auth() })
  ).json<{ partners: { alias_id: string; display_name: string }[] }>().partners;
  const alias = aliases.find((row) => row.display_name === displayName);
  if (alias === undefined) throw new Error('Псевдоним партнёра не найден');

  return { id, aliasId: alias.alias_id, simId };
}

async function setRate(partnerId: string, operatorId: string, price: string): Promise<void> {
  const response = await post('/partner-rates', {
    partnerId,
    operatorId,
    pricePerMinute: price,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  expect(response.statusCode).toBe(201);
}

async function resolveNumber(destination: string, operatorId: string): Promise<void> {
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into number_resolutions (id, msisdn, operator_id, source, resolved_at, expires_at)
      values (gen_random_uuid()::text::uuid, ${destination}, ${operatorId}, 'manual', now(), now() + interval '30 days')
    `);
  });
}

let clientId = '';
let channelId = '';

/** Проводит вызов и отвечает, чья SIM его приняла. Отказ возвращается причиной. */
async function routeVia(destination: string): Promise<string> {
  const response = await post('/routing/preview', {
    callId: unique('uuid'),
    channelId,
    nodeId,
    destination,
  });
  const decision = response.json<{
    outcome: string;
    reason: string | null;
    candidates: { sim_card_id: string }[];
  }>();
  if (decision.outcome === 'rejected') return `отказ:${decision.reason ?? '—'}`;

  const first = decision.candidates[0];
  if (first === undefined) throw new Error('Маршрут без кандидатов');
  return first.sim_card_id;
}

let operatorA = '';
let operatorB = '';
let cheapOnA: Partner;
let cheapOnB: Partner;
let numbers = { a: '', b: '' };

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

  // Узел доводится до рабочего ключа: без него нечем отметить регистрацию шлюза,
  // а без регистрации маршрутизация его не выберет.
  const command = provisioned.json<{ install: { command: string } }>().install.command;
  const enrolled = await api().inject({
    method: 'POST',
    url: '/node/enroll',
    headers: { authorization: `Bearer ${command.slice(command.lastIndexOf(' ') + 1)}` },
    payload: { hostname: unique('node'), agentVersion: '1.0.0' },
  });
  const key = enrolled.json<{ key: { key_id: string; secret: string } }>().key;
  nodeKey = `${key.key_id}.${key.secret}`;

  operatorA = (await post('/operators', { name: unique('Оператор-А') })).json<{
    operator: { id: string };
  }>().operator.id;
  operatorB = (await post('/operators', { name: unique('Оператор-Б') })).json<{
    operator: { id: string };
  }>().operator.id;

  cheapOnA = await createPartner(operatorA);
  cheapOnB = await createPartner(operatorB);

  // У каждого партнёра SIM только своего оператора — этого мало для проверки разницы
  // по направлениям. Дадим каждому по второй SIM другого оператора.
  const second = await createSecondSim(cheapOnA.id, operatorB);
  const third = await createSecondSim(cheapOnB.id, operatorA);
  simOfA[operatorB] = second;
  simOfB[operatorA] = third;
  simOfA[operatorA] = cheapOnA.simId;
  simOfB[operatorB] = cheapOnB.simId;

  // Первый дёшев на А и дорог на Б, второй — наоборот.
  await setRate(cheapOnA.id, operatorA, '1.80');
  await setRate(cheapOnA.id, operatorB, '4.00');
  await setRate(cheapOnB.id, operatorA, '4.00');
  await setRate(cheapOnB.id, operatorB, '1.80');

  const owner = await api().get(IdentityService).createByAdmin({
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    fullName: 'Диспетчер',
    role: 'client',
    status: 'active',
  });
  clientId = (await post('/clients', { ownerUserId: owner.id, name: unique('Такси') })).json<{
    client: { id: string };
  }>().client.id;
  await patch(`/clients/${clientId}/status`, { status: 'active' });
  channelId = (await post('/channels', { clientId, name: unique('Линия') })).json<{
    channel: { id: string };
  }>().channel.id;
  await post(`/channels/${channelId}/status`, { status: 'active' });
  await post('/commission-rules', {
    clientId,
    percentBasisPoints: 1500,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  await post(`/clients/${clientId}/deposit`, {
    amount: '100000',
    idempotencyKey: unique('deposit'),
    description: 'Пополнение под проверку',
  });

  numbers = { a: nextMsisdn(), b: nextMsisdn() };
  await resolveNumber(numbers.a, operatorA);
  await resolveNumber(numbers.b, operatorB);
}, 180_000);

const simOfA: Record<string, string> = {};
const simOfB: Record<string, string> = {};

/**
 * Чья SIM приняла вызов. Партнёр отдаёт вызов **любой** своей карте с ценой на номер:
 * куда SIM звонит, решает её тариф, а не её оператор (ADR-0056). Порядок решает
 * предложение партнёра, и сравнивать надо партнёра, а не конкретную карту.
 */
function partnerOf(result: string): string {
  if (Object.values(simOfA).includes(result)) return 'A';
  if (Object.values(simOfB).includes(result)) return 'B';
  return result;
}

/** Вторая SIM партнёра — другого оператора, чтобы он мог звонить в оба направления. */
async function createSecondSim(partnerId: string, operatorId: string): Promise<string> {
  const gateway = (
    await post('/gateways', { partnerId, name: unique('Шлюз'), type: 'goip' })
  ).json<{ gateway: { id: string } }>().gateway.id;
  await post(`/gateways/${gateway}/status`, { status: 'active' });
  // Маршрутизация выбирает только шлюзы, зарегистрированные на принявшем вызов узле.
  await registerGateway(api(), nodeKey, gateway);

  const port = (await post(`/gateways/${gateway}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;
  const simId = (await post('/sim-cards', { partnerId, operatorId, msisdn: nextMsisdn() })).json<{
    sim: { id: string };
  }>().sim.id;
  await post(`/sim-cards/${simId}/status`, { status: 'active' });
  expect(
    (await post(`/sim-cards/${simId}/concurrency`, { maxConcurrentCalls: 8 })).statusCode,
  ).toBe(201);
  await post(`/gateway-ports/${port}/sim`, { simCardId: simId });
  return simId;
}

afterAll(async () => {
  await app?.close();
});

describe('цена решает порядок', () => {
  it('без приоритетов вызов уходит к дешёвому', async () => {
    expect(partnerOf(await routeVia(numbers.a))).toBe('A');
  }, 120_000);

  it('разница цен по операторам решается сама, без настройки клиента', async () => {
    // Один и тот же канал, один и тот же пустой список приоритетов. Направления разные —
    // и первым встаёт тот, кто дешевле именно на нём.
    expect(partnerOf(await routeVia(numbers.a))).toBe('A');
    expect(partnerOf(await routeVia(numbers.b))).toBe('B');
  }, 120_000);

  it('приоритет клиента сильнее цены: он платит за то, чего вычислить нельзя', async () => {
    const saved = await api().inject({
      method: 'PUT',
      url: `/channels/${channelId}/partner-priorities`,
      headers: auth(),
      payload: { priorities: [{ aliasId: cheapOnB.aliasId, priority: 1 }] },
    });
    expect(saved.statusCode).toBe(200);

    try {
      // На операторе А второй партнёр дороже вдвое — и всё равно первый, потому что
      // клиент назвал его сам.
      expect(partnerOf(await routeVia(numbers.a))).toBe('B');
    } finally {
      await api().inject({
        method: 'PUT',
        url: `/channels/${channelId}/partner-priorities`,
        headers: auth(),
        payload: { priorities: [] },
      });
    }
  }, 120_000);
});

describe('цена как условие участия', () => {
  it('партнёр без цены по направлению в перебор не попадает', async () => {
    const operatorC = (await post('/operators', { name: unique('Оператор-В') })).json<{
      operator: { id: string };
    }>().operator.id;

    const withRate = await createPartner(operatorC);
    const withoutRate = await createPartner(operatorC);
    await setRate(withRate.id, operatorC, '3.00');

    const destination = nextMsisdn();
    await resolveNumber(destination, operatorC);

    // Партнёр без цены есть и годен по всем прочим признакам — но вызов уходит
    // не к нему, а туда, где цена есть.
    expect(await routeVia(destination)).toBe(withRate.simId);
    expect(withoutRate.simId).not.toBe(withRate.simId);
  }, 120_000);

  it('нет цены ни у кого — отказ называет тариф, а не отсутствие SIM', async () => {
    const operatorD = (await post('/operators', { name: unique('Оператор-Г') })).json<{
      operator: { id: string };
    }>().operator.id;
    await createPartner(operatorD);

    const destination = nextMsisdn();
    await resolveNumber(destination, operatorD);

    expect(await routeVia(destination)).toBe('отказ:no_tariff');
  }, 120_000);
});

describe('способ терминации у цены', () => {
  it('цена, назначенная транку, не подходит SIM', async () => {
    const operatorE = (await post('/operators', { name: unique('Оператор-Д') })).json<{
      operator: { id: string };
    }>().operator.id;
    const partner = await createPartner(operatorE);

    // Цена есть, но она про другой способ терминации — для SIM её нет.
    const response = await post('/partner-rates', {
      partnerId: partner.id,
      operatorId: operatorE,
      terminationKind: 'sip',
      pricePerMinute: '2.00',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ rate: { termination_kind: string } }>().rate.termination_kind).toBe(
      'sip',
    );

    const destination = nextMsisdn();
    await resolveNumber(destination, operatorE);
    expect(await routeVia(destination)).toBe('отказ:no_tariff');
  }, 120_000);

  it('приоритет задаётся предложению: SIM и транк одного партнёра — разные строки', async () => {
    const saved = await api().inject({
      method: 'PUT',
      url: `/channels/${channelId}/partner-priorities`,
      headers: auth(),
      payload: {
        priorities: [
          { aliasId: cheapOnA.aliasId, terminationKind: 'sim', priority: 1 },
          { aliasId: cheapOnA.aliasId, terminationKind: 'sip', priority: 9 },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);

    const rows = saved.json<{
      priorities: { alias_id: string; termination_kind: string; priority: number }[];
    }>().priorities;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.termination_kind).sort()).toEqual(['sim', 'sip']);

    // На SIM приоритет 1 — вызов уходит к нему даже там, где он дороже.
    expect(partnerOf(await routeVia(numbers.b))).toBe('A');

    await api().inject({
      method: 'PUT',
      url: `/channels/${channelId}/partner-priorities`,
      headers: auth(),
      payload: { priorities: [] },
    });
  }, 120_000);

  it('одно и то же предложение дважды — отказ, а два способа одного партнёра — нет', async () => {
    const twice = await api().inject({
      method: 'PUT',
      url: `/channels/${channelId}/partner-priorities`,
      headers: auth(),
      payload: {
        priorities: [
          { aliasId: cheapOnA.aliasId, terminationKind: 'sim', priority: 1 },
          { aliasId: cheapOnA.aliasId, terminationKind: 'sim', priority: 2 },
        ],
      },
    });
    expect(twice.statusCode).toBe(400);
  }, 120_000);
});

describe('тарифы партнёра (ADR-0056)', () => {
  /** Новый оператор и номер, подтверждённо принадлежащий ему. */
  async function destinationOf(): Promise<{ operator: string; number: string }> {
    const operator = (await post('/operators', { name: unique('Оператор-Т') })).json<{
      operator: { id: string };
    }>().operator.id;
    const number = nextMsisdn();
    await resolveNumber(number, operator);
    return { operator, number };
  }

  it('карта звонит чужому оператору по цене «на все операторы»', async () => {
    // Владелец: «какая разница какой оператор — звонки всё равно должны проходить».
    // Карта оператора А, номер оператора Т: раньше кандидатом она не была вовсе.
    const partner = await createPartner(operatorA);
    const everywhere = await post('/partner-rates', {
      partnerId: partner.id,
      pricePerMinute: '2.50',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
    expect(everywhere.statusCode).toBe(201);

    const { number } = await destinationOf();
    expect(await routeVia(number)).toBe(partner.simId);
  }, 120_000);

  it('свой тариф SIM сильнее тарифа шлюза и тарифа по умолчанию', async () => {
    const { operator, number } = await destinationOf();
    const cheap = await createPartner(operatorA);
    const rival = await createPartner(operatorA);
    await setRate(cheap.id, operator, '1.00');
    // Дешевле цены «на все операторы» 2,50 из соседней проверки: та карта звонит
    // и сюда, и иначе соперником оказалась бы она.
    await setRate(rival.id, operator, '2.00');
    expect(await routeVia(number)).toBe(cheap.simId);

    // У дешёвого партнёра второй тариф — дорогой, и его карта переходит на него.
    const expensive = (
      await post(`/partners/${cheap.id}/tariffs`, { name: unique('Дорогой') })
    ).json<{ tariff: { id: string } }>().tariff.id;
    expect(
      (
        await post('/partner-rates', {
          partnerId: cheap.id,
          tariffId: expensive,
          operatorId: operator,
          pricePerMinute: '9.00',
          effectiveFrom: '2020-01-01T00:00:00.000Z',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await post(`/sim-cards/${cheap.simId}/tariff`, { tariffId: expensive })).statusCode,
    ).toBe(201);

    // Теперь дешевле соперник: цена своя у каждой карты.
    expect(await routeVia(number)).toBe(rival.simId);
  }, 120_000);

  it('вызов запоминает строку цены, по которой пошёл', async () => {
    const { operator, number } = await destinationOf();
    const partner = await createPartner(operatorA);
    const rate = (
      await post('/partner-rates', {
        partnerId: partner.id,
        operatorId: operator,
        pricePerMinute: '1.50',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      })
    ).json<{ rate: { id: string } }>().rate.id;

    const callId = unique('call');
    const response = await post('/routing/preview', {
      callId,
      channelId,
      nodeId,
      destination: number,
    });
    expect(response.json<{ outcome: string }>().outcome).toBe('routed');
    const stored = await withDatabase(async (execute) =>
      execute(sql`select partner_rate_id from calls where external_id = ${callId}`),
    );
    // По этой строке тарифицируется CDR: смена тарифа SIM посреди разговора цену
    // этого вызова не меняет.
    expect(stored.rows[0]?.['partner_rate_id']).toBe(rate);
  }, 120_000);

  it('оператор не подтверждён — цена по владельцу диапазона', async () => {
    // Источник подтверждения в тестах отключён; номер есть только в плане нумерации.
    const owner = (await post('/operators', { name: unique('Оператор-П') })).json<{
      operator: { id: string };
    }>().operator.id;
    await withDatabase(async (execute) => {
      await execute(sql`
        insert into numbering_plan_ranges
          (id, def_code, range_start, range_end, capacity, operator_id, region, source, imported_at)
        values (gen_random_uuid(), '947', 79470000000, 79470009999, 10000,
                ${owner}::uuid, null, 'mincifry', now())
      `);
    });
    const partner = await createPartner(operatorA);
    await setRate(partner.id, owner, '2.00');

    expect(await routeVia('79470001234')).toBe(partner.simId);
  }, 120_000);
});
