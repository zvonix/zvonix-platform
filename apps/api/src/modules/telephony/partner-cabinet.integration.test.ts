/**
 * Партнёрский контур на реальной базе.
 *
 * Проверяется **граница**, а не удобство: партнёр видит только своё, идентификатор
 * партнёра нигде не принимается, а пароль провайдера не покидает узел
 * ([ADR-0039](../../../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
 *
 * Зеркало клиентской проверки [client-cabinet.integration.test.ts](client-cabinet.integration.test.ts):
 * там смотрят, что клиент не видит партнёра, здесь — что партнёр не видит соседа.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  holdTransaction,
  prepareEnvironment,
  registerGateway,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
  waitUntilBlocked,
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
  return `7941${String(1000000 + msisdnCounter)}`;
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

/** Объявить номер принадлежащим оператору — так же, как это делает источник. */
async function declare(msisdn: string, operator: string): Promise<void> {
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into number_resolutions (id, msisdn, operator_id, source, resolved_at, expires_at)
      values (gen_random_uuid()::text::uuid, ${msisdn}, ${operator}, 'manual', now(), now() + interval '30 days')
    `);
  });
}

async function login(email: string): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return response.json<{ token: string }>().token;
}

async function createUser(role: 'client' | 'partner'): Promise<{ id: string; token: string }> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  const created = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Владелец',
    role,
    status: 'active',
  });
  return { id: created.id, token: await login(email) };
}

interface AccountResponse {
  partner: {
    id: string;
    name: string;
    display_name: string | null;
    status: string;
    listens_to_recordings: boolean;
  };
  funds: { balance: string };
}

interface EquipmentResponse {
  gateways: {
    id: string;
    name: string;
    type: string;
    status: string;
    suspended_by: string | null;
    on_node: boolean;
    registered_at: string | null;
    ports: {
      id: string;
      port_number: number;
      sim: { id: string; msisdn: string; operator_name: string | null } | null;
    }[];
  }[];
  trunks: {
    id: string;
    name: string;
    proxy_host: string;
    outbound_username: string | null;
    max_concurrent_calls: number;
  }[];
  spare_sims: { id: string; msisdn: string }[];
}

interface RatesResponse {
  reference_call_seconds: number;
  rates: {
    operator_id: string;
    operator_name: string | null;
    termination_kind: string;
    price_per_minute: string;
    effective_from: string;
    reference_cost: string;
    band: { min_price: string; max_price: string } | null;
    within_band: boolean;
  }[];
  operators_without_price: { operator_id: string; operator_name: string }[];
  open_directions: { operator_id: string; min_price: string; max_price: string }[];
}

/** Партнёр целиком: учётная запись, запись партнёра, шлюз с SIM, транк и цены. */
async function createPartner(name: string) {
  const owner = await createUser('partner');
  const displayName = unique('Псевдоним');
  const id = (await post('/partners', { ownerUserId: owner.id, name, displayName })).json<{
    partner: { id: string };
  }>().partner.id;
  expect((await patch(`/partners/${id}/status`, { status: 'verified' })).statusCode).toBe(200);

  return { id, displayName, token: owner.token, userId: owner.id };
}

const PROVIDER_SECRET = 'парольПровайдера-не-для-чужих-глаз';

let operatorId = '';
let operatorName = '';
let silentOperatorId = '';
let silentOperatorName = '';
let mine: Awaited<ReturnType<typeof createPartner>>;
let neighbour: Awaited<ReturnType<typeof createPartner>>;
let myGateway = '';
let mySim = '';
let spareSim = '';
let myTrunk = '';
let clientToken = '';

async function buildScenario(): Promise<void> {
  operatorName = unique('Оператор');
  operatorId = (await post('/operators', { name: operatorName })).json<{
    operator: { id: string };
  }>().operator.id;

  // Второй оператор — подтверждённый, но без цены: по нему партнёр не получит ни одного
  // вызова, и кабинет обязан назвать это прямо.
  silentOperatorName = unique('Оператор-без-цены');
  silentOperatorId = (await post('/operators', { name: silentOperatorName })).json<{
    operator: { id: string };
  }>().operator.id;

  mine = await createPartner('Иванов Иван');
  neighbour = await createPartner('Петров Пётр');

  myGateway = (
    await post('/gateways', { partnerId: mine.id, name: unique('Шлюз'), type: 'goip' })
  ).json<{ gateway: { id: string } }>().gateway.id;
  await post(`/gateways/${myGateway}/status`, { status: 'active' });

  const port = (await post(`/gateways/${myGateway}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;
  mySim = (
    await post('/sim-cards', { partnerId: mine.id, operatorId, msisdn: nextMsisdn() })
  ).json<{ sim: { id: string } }>().sim.id;
  await post(`/sim-cards/${mySim}/status`, { status: 'active' });
  expect((await post(`/gateway-ports/${port}/sim`, { simCardId: mySim })).statusCode).toBe(201);

  // Карта, заведённая, но никуда не вставленная: нигде больше её не видно.
  spareSim = (
    await post('/sim-cards', { partnerId: mine.id, operatorId, msisdn: nextMsisdn() })
  ).json<{ sim: { id: string } }>().sim.id;

  const trunk = await post('/sip-trunks', {
    partnerId: mine.id,
    nodeId,
    name: unique('Транк'),
    proxyHost: 'sip.provider.test',
    registersOutbound: true,
    outboundUsername: 'zvonix-test',
    outboundSecret: PROVIDER_SECRET,
    maxConcurrentCalls: 30,
  });
  expect(trunk.statusCode).toBe(201);
  myTrunk = trunk.json<{ trunk: { id: string } }>().trunk.id;

  // Соседу — своё железо: оно не должно попасть ни в один ответ проверяемого партнёра.
  const theirs = (
    await post('/gateways', { partnerId: neighbour.id, name: unique('ЧужойШлюз'), type: 'goip' })
  ).json<{ gateway: { id: string } }>().gateway.id;
  await post(`/gateways/${theirs}/status`, { status: 'active' });
  const theirSim = (
    await post('/sim-cards', { partnerId: neighbour.id, operatorId, msisdn: nextMsisdn() })
  ).json<{ sim: { id: string } }>().sim.id;
  await post(`/sim-cards/${theirSim}/status`, { status: 'active' });

  // Коридор по направлению и цена внутри него.
  expect(
    (
      await post('/price-bands', {
        operatorId,
        minPrice: '1',
        maxPrice: '5',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      })
    ).statusCode,
  ).toBe(201);
  // У второго оператора коридор есть, а цены партнёра нет: ровно то направление,
  // которое кабинет предлагает заполнить, — и заполнить его партнёр должен уметь сам.
  expect(
    (
      await post('/price-bands', {
        operatorId: silentOperatorId,
        minPrice: '1',
        maxPrice: '9',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      })
    ).statusCode,
  ).toBe(201);
  expect(
    (
      await post('/partner-rates', {
        partnerId: mine.id,
        operatorId,
        terminationKind: 'sim',
        pricePerMinute: '2',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      })
    ).statusCode,
  ).toBe(201);
  // Транк того же партнёра по тому же оператору — вторая цена того же направления.
  expect(
    (
      await post('/partner-rates', {
        partnerId: mine.id,
        operatorId,
        terminationKind: 'sip',
        pricePerMinute: '4',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      })
    ).statusCode,
  ).toBe(201);
  await post('/partner-rates', {
    partnerId: neighbour.id,
    operatorId,
    pricePerMinute: '3',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
}

/** Состоявшийся разговор через железо проверяемого партнёра — ради проводки. */
async function makeCall(): Promise<void> {
  await registerGateway(api(), nodeKey, myGateway);

  const client = await createUser('client');
  clientToken = client.token;
  const clientId = (
    await post('/clients', { ownerUserId: client.id, name: unique('Такси') })
  ).json<{ client: { id: string } }>().client.id;
  await patch(`/clients/${clientId}/status`, { status: 'active' });
  const channel = (await post('/channels', { clientId, name: unique('Линия') })).json<{
    channel: { id: string };
  }>().channel.id;
  await post(`/channels/${channel}/status`, { status: 'active' });
  await post('/commission-rules', {
    clientId,
    percentBasisPoints: 1500,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  await post(`/clients/${clientId}/deposit`, {
    amount: '10000',
    idempotencyKey: unique('deposit'),
    description: 'Пополнение под проверку',
  });

  // Порядок партнёров задавать не нужно: у соседа нет ни одного кандидата — его SIM
  // никуда не вставлена, а шлюз не зарегистрирован. Вызов уйдёт единственному годному.
  const destination = nextMsisdn();
  await declare(destination, operatorId);

  const callId = unique('uuid');
  const routed = await post('/routing/preview', {
    callId,
    channelId: channel,
    nodeId,
    destination,
  });
  expect(routed.json<{ outcome: string }>().outcome).toBe('routed');

  expect(
    (
      await post(
        '/node/cdr',
        {
          variables: {
            uuid: callId,
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
  await makeCall();
}, 240_000);

afterAll(async () => {
  await app?.close();
});

describe('партнёр о себе', () => {
  it('видит своё состояние и псевдоним, под которым его выбирает клиент', async () => {
    const response = await get('/partner/account', as(mine.token));
    expect(response.statusCode).toBe(200);

    const body = response.json<AccountResponse>();
    expect(body.partner.id).toBe(mine.id);
    expect(body.partner.name).toBe('Иванов Иван');
    expect(body.partner.display_name).toBe(mine.displayName);
    expect(body.partner.status).toBe('verified');
    expect(body.partner.listens_to_recordings).toBe(false);
  });

  it('видит заработанное: разговор дошёл до его счёта', async () => {
    const body = (await get('/partner/account', as(mine.token))).json<AccountResponse>();
    expect(Number(body.funds.balance)).toBeGreaterThan(0);
  });

  it('видит, за что начислено: у проводки есть вызов', async () => {
    const response = await get('/partner/entries', as(mine.token));
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      entries: { kind: string; amount: string; reference_type: string | null }[];
      total: number;
    }>();
    expect(body.total).toBeGreaterThan(0);
    expect(body.entries[0]?.reference_type).toBe('call');
  });

  it('сосед со своим разговором сюда не попадает', async () => {
    const body = (await get('/partner/account', as(neighbour.token))).json<AccountResponse>();
    expect(body.partner.id).toBe(neighbour.id);
    expect(body.funds.balance).toBe('0');
  });
});

describe('оборудование партнёра', () => {
  it('шлюз отдаётся с портом и вставленной в него SIM', async () => {
    const response = await get('/partner/equipment', as(mine.token));
    expect(response.statusCode).toBe(200);

    const body = response.json<EquipmentResponse>();
    expect(body.gateways).toHaveLength(1);
    const gateway = body.gateways[0];
    expect(gateway?.id).toBe(myGateway);
    expect(gateway?.ports).toHaveLength(1);
    expect(gateway?.ports[0]?.sim?.id).toBe(mySim);
    expect(gateway?.ports[0]?.sim?.operator_name).toBe(operatorName);
  });

  it('регистрация на узле видна: без неё вызов на шлюз не уйдёт вовсе', async () => {
    const body = (await get('/partner/equipment', as(mine.token))).json<EquipmentResponse>();
    expect(body.gateways[0]?.on_node).toBe(true);
    expect(body.gateways[0]?.registered_at).not.toBeNull();
  });

  it('карта без порта видна отдельно — иначе её не видно нигде', async () => {
    const body = (await get('/partner/equipment', as(mine.token))).json<EquipmentResponse>();
    expect(body.spare_sims.map((sim) => sim.id)).toEqual([spareSim]);
  });

  it('транк отдаётся отдельно от шлюзов и без пароля провайдера', async () => {
    const response = await get('/partner/equipment', as(mine.token));
    const body = response.json<EquipmentResponse>();

    expect(body.trunks.map((trunk) => trunk.id)).toEqual([myTrunk]);
    expect(body.trunks[0]?.proxy_host).toBe('sip.provider.test');
    expect(body.trunks[0]?.max_concurrent_calls).toBe(30);
    // Транк — тоже шлюз, но в списке шлюзов ему делать нечего: портов у него нет.
    expect(body.gateways.map((gateway) => gateway.id)).not.toContain(myTrunk);
    // Пароль провайдера уходит только узлу. Проверяется по всему телу, а не по полю:
    // утечь он может и через поле, которого сегодня нет.
    expect(response.body).not.toContain(PROVIDER_SECRET);
  });

  it('чужого железа не видно ни в одном списке', async () => {
    const body = (await get('/partner/equipment', as(neighbour.token))).json<EquipmentResponse>();
    expect(body.gateways.map((gateway) => gateway.id)).not.toContain(myGateway);
    expect(body.trunks).toHaveLength(0);
    expect(body.spare_sims.map((sim) => sim.id)).not.toContain(spareSim);
  });
});

describe('цены партнёра', () => {
  it('обе цены одного направления на месте: SIM и транк — разные предложения', async () => {
    const body = (await get('/partner/rates', as(mine.token))).json<RatesResponse>();
    const own = body.rates.filter((rate) => rate.operator_id === operatorId);

    expect(own.map((rate) => rate.termination_kind).sort()).toEqual(['sim', 'sip']);
    expect(own.find((rate) => rate.termination_kind === 'sim')?.price_per_minute).toBe('2');
    expect(own.find((rate) => rate.termination_kind === 'sip')?.price_per_minute).toBe('4');
  });

  it('открытые направления отдают общий коридор, а не коридор своей цены', async () => {
    // У цены стоит её собственный коридор — для региональной он может быть региональным.
    // Рамки для новой цены «на любой регион» обязаны быть общими, иначе форма назовёт
    // не те границы.
    const body = (await get('/partner/rates', as(mine.token))).json<RatesResponse>();
    const open = body.open_directions.find((row) => row.operator_id === operatorId);

    expect(open).toMatchObject({ operator_id: operatorId, min_price: '1', max_price: '5' });
  }, 60_000);

  it('коридор стоит рядом с ценой, иначе двигаться некуда', async () => {
    const body = (await get('/partner/rates', as(mine.token))).json<RatesResponse>();
    const rate = body.rates.find((row) => row.termination_kind === 'sim');

    expect(body.reference_call_seconds).toBe(60);
    expect(rate?.band).toEqual({ min_price: '1', max_price: '5' });
    expect(rate?.reference_cost).toBe('2');
    expect(rate?.within_band).toBe(true);
  });

  it('оператор без цены назван прямо: туда не уйдёт ни один вызов', async () => {
    const body = (await get('/partner/rates', as(mine.token))).json<RatesResponse>();
    const silent = body.operators_without_price.map((row) => row.operator_id);

    expect(silent).toContain(silentOperatorId);
    expect(silent).not.toContain(operatorId);
  });

  it('чужой цены не видно', async () => {
    const body = (await get('/partner/rates', as(neighbour.token))).json<RatesResponse>();
    expect(body.rates.map((rate) => rate.price_per_minute)).toEqual(['3']);
  });
});

describe('партнёр назначает себе цену', () => {
  it('принимает цену внутри коридора и показывает её сразу', async () => {
    const response = await post(
      '/partner/rates',
      {
        operatorId: silentOperatorId,
        terminationKind: 'sim',
        pricePerMinute: '4',
      },
      as(mine.token),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json<{ rate: { price_per_minute: string } }>().rate.price_per_minute).toBe('4');

    const body = (await get('/partner/rates', as(mine.token))).json<RatesResponse>();
    const added = body.rates.find((rate) => rate.operator_id === silentOperatorId);
    expect(added?.price_per_minute).toBe('4');
    expect(added?.within_band).toBe(true);
    // Направление ушло из списка «цены нет»: иначе партнёр видел бы его в обоих местах.
    expect(body.operators_without_price.map((row) => row.operator_id)).not.toContain(
      silentOperatorId,
    );
  }, 60_000);

  it('цену вне коридора не принимает и называет обе границы', async () => {
    const response = await post(
      '/partner/rates',
      { operatorId: operatorId, terminationKind: 'sim', pricePerMinute: '99' },
      as(mine.token),
    );
    expect(response.statusCode).toBe(400);

    const error = response.json<{
      error: { code: string; details: { min_price: string; max_price: string } };
    }>().error;
    expect(error.code).toBe('validation_failed');
    expect(error.details.min_price).toBe('1');
    expect(error.details.max_price).toBe('5');
  }, 60_000);

  it('коридор не обходится платой за соединение', async () => {
    // Цена за минуту внутри коридора, а вызов в 60 секунд стоит куда больше верхней
    // границы: коридор меряет стоимость эталонного вызова, а не одно из пяти чисел.
    const response = await post(
      '/partner/rates',
      {
        operatorId: operatorId,
        terminationKind: 'sim',
        pricePerMinute: '2',
        connectionFee: '50',
      },
      as(mine.token),
    );
    expect(response.statusCode).toBe(400);
    expect(
      response.json<{ error: { details: { reference_cost: string } } }>().error.details
        .reference_cost,
    ).toBe('52');
  }, 60_000);

  it('отрицательная плата за соединение — отказ по вводу, а не поломка', async () => {
    // Расчёт тарифа отвергает такую величину сам, но раньше его отказ уходил наружу
    // внутренней ошибкой: человек, ошибшийся в поле, видел поломку площадки.
    const response = await post(
      '/partner/rates',
      {
        operatorId: operatorId,
        terminationKind: 'sim',
        pricePerMinute: '52',
        connectionFee: '-50',
      },
      as(mine.token),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  }, 60_000);

  it('по направлению без коридора цену не назначить вовсе', async () => {
    const bare = (await post('/operators', { name: unique('Оператор-без-коридора') })).json<{
      operator: { id: string };
    }>().operator.id;

    const response = await post(
      '/partner/rates',
      { operatorId: bare, terminationKind: 'sim', pricePerMinute: '3' },
      as(mine.token),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toContain('коридор');

    // Кабинет обязан сказать это **до** отправки: направления нет среди открытых,
    // и в форме оно не выбирается вовсе.
    const body = (await get('/partner/rates', as(mine.token))).json<RatesResponse>();
    expect(body.open_directions.map((row) => row.operator_id)).not.toContain(bare);
    expect(body.operators_without_price.map((row) => row.operator_id)).toContain(bare);
  }, 60_000);

  it('администратору то же направление без коридора не запрещено', async () => {
    // Иначе новое направление невозможно открыть: коридор задаёт он же (ADR-0023).
    const bare = (await post('/operators', { name: unique('Оператор-без-коридора') })).json<{
      operator: { id: string };
    }>().operator.id;

    expect(
      (
        await post('/partner-rates', {
          partnerId: neighbour.id,
          operatorId: bare,
          terminationKind: 'sim',
          pricePerMinute: '3',
          effectiveFrom: '2020-01-01T00:00:00.000Z',
        })
      ).statusCode,
    ).toBe(201);
  }, 60_000);

  it('чужую цену не назначить: партнёр берётся из сессии, а не из тела', async () => {
    const response = await post(
      '/partner/rates',
      {
        partnerId: neighbour.id,
        operatorId: operatorId,
        terminationKind: 'sim',
        pricePerMinute: '2',
      },
      as(mine.token),
    );
    expect(response.statusCode).toBe(201);

    // Цена ушла тому, чья сессия, — лишнее поле в теле ни на что не влияет.
    const theirs = (await get('/partner/rates', as(neighbour.token))).json<RatesResponse>();
    const same = theirs.rates.filter((rate) => rate.operator_id === operatorId);
    expect(same).toHaveLength(1);
    expect(same[0]?.price_per_minute).toBe('3');
  }, 60_000);

  it('в журнал попадает весь тариф, а не одна цена за минуту', async () => {
    // Спор «сколько он поставил» решается платой за соединение и минимальной
    // длительностью не меньше, чем ценой за минуту: половина тарифа в журнале
    // не отвечает на вопрос, ради которого журнал ведётся.
    expect(
      (
        await post(
          '/partner/rates',
          {
            operatorId: silentOperatorId,
            terminationKind: 'sip',
            pricePerMinute: '3',
            connectionFee: '1.5',
            billingIncrementSeconds: 30,
            minimumDurationSeconds: 30,
          },
          as(mine.token),
        )
      ).statusCode,
    ).toBe(201);

    const journal = await get('/audit?action=partner_rate.added&limit=50');
    expect(journal.statusCode).toBe(200);

    const entries = journal.json<{
      entries: { actor_role: string; after: Record<string, unknown> | null }[];
    }>().entries;
    const own = entries.find(
      (entry) => entry.actor_role === 'partner' && entry.after?.['connection_fee'] === '1500000',
    );

    expect(own?.after).toMatchObject({
      termination_kind: 'sip',
      price_per_minute: '3000000',
      billing_increment_seconds: 30,
      minimum_duration_seconds: 30,
      rounding: 'half_away_from_zero',
    });
  }, 60_000);

  it('задним числом цену не поставить: коридор был бы выбран другой', async () => {
    const response = await post(
      '/partner/rates',
      {
        operatorId: operatorId,
        terminationKind: 'sim',
        pricePerMinute: '2',
        effectiveFrom: '2019-01-01T00:00:00.000Z',
      },
      as(mine.token),
    );
    expect(response.statusCode).toBe(201);

    // Поле проигнорировано, а не принято: цена действует с этого момента.
    const body = (await get('/partner/rates', as(mine.token))).json<RatesResponse>();
    const added = body.rates.find(
      (rate) => rate.operator_id === operatorId && rate.termination_kind === 'sim',
    );
    expect(new Date(added?.effective_from ?? 0).getUTCFullYear()).toBeGreaterThan(2019);
  }, 60_000);
});

describe('границы контура', () => {
  it('клиента в партнёрский контур не пускают', async () => {
    for (const url of ['/partner/account', '/partner/equipment', '/partner/rates']) {
      expect((await get(url, as(clientToken))).statusCode).toBe(403);
    }
    expect(
      (
        await post(
          '/partner/rates',
          { operatorId, terminationKind: 'sim', pricePerMinute: '1' },
          as(clientToken),
        )
      ).statusCode,
    ).toBe(403);
  });

  it('администратора тоже: у него свои обработчики с идентификатором в адресе', async () => {
    expect((await get('/partner/account')).statusCode).toBe(403);
  });

  it('учётная запись без партнёра получает отказ, а не пустой кабинет', async () => {
    // Кабинет открывает владение карточкой, а не роль (ADR-0052).
    const orphan = await createUser('partner');
    const response = await get('/partner/account', as(orphan.token));

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'permission_denied',
      message: 'Кабинет партнёра не подключён',
    });
  });
});

describe('партнёр заводит своё оборудование (ADR-0043)', () => {
  it('заводит шлюз и получает пароль SIP там же, где его вводит', async () => {
    const response = await post(
      '/partner/gateways',
      { name: unique('Свой шлюз'), type: 'goip' },
      as(mine.token),
    );
    expect(response.statusCode).toBe(201);

    const body = response.json<{
      gateway: { id: string; status: string };
      account: { username: string; password: string };
    }>();
    // Заведённый шлюз трафика не берёт: учётная запись выдаётся только в `active`.
    expect(body.gateway.status).toBe('pending');
    // Пароль отдаётся один раз и здесь — прежде он обязан был дойти до партнёра перепиской.
    expect(body.account.password.length).toBeGreaterThan(10);
    expect(body.account.username).toMatch(/^gw-/u);
  });

  it('включает свой шлюз сам: человек в этом месте ничего не решает', async () => {
    const created = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(mine.token))
    ).json<{ gateway: { id: string } }>().gateway.id;

    const response = await post(
      `/partner/gateways/${created}/status`,
      { status: 'active' },
      as(mine.token),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json<{ gateway: { status: string } }>().gateway.status).toBe('active');
  });

  it('не снимает отключение, поставленное площадкой', async () => {
    const created = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(mine.token))
    ).json<{ gateway: { id: string } }>().gateway.id;

    // Рычаг площадки против злоупотребления — он не должен сниматься тем, против кого стоит.
    expect((await post(`/gateways/${created}/status`, { status: 'suspended' })).statusCode).toBe(
      201,
    );
    const response = await post(
      `/partner/gateways/${created}/status`,
      { status: 'active' },
      as(mine.token),
    );
    expect(response.statusCode).toBe(409);
  });

  it('чужого оборудования для партнёра не существует — 404, а не 403', async () => {
    // `403` сообщил бы, что объект есть и он чужой. Партнёр не должен узнавать и этого.
    const response = await post(
      `/partner/gateways/${myGateway}/status`,
      { status: 'suspended' },
      as(neighbour.token),
    );
    expect(response.statusCode).toBe(404);

    expect(
      (await post(`/partner/gateways/${myGateway}/ports`, { portNumber: 9 }, as(neighbour.token)))
        .statusCode,
    ).toBe(404);
    expect(
      (await post(`/partner/gateways/${myGateway}/credentials`, {}, as(neighbour.token)))
        .statusCode,
    ).toBe(404);
  });

  it('заведённая SIM не берёт вызовы, пока оператор не подтверждён', async () => {
    const msisdn = nextMsisdn();
    const sim = (await post('/partner/sim-cards', { operatorId, msisdn }, as(mine.token))).json<{
      sim: { id: string; status: string };
    }>().sim;
    expect(sim.status).toBe('new');

    // Источник о номере ничего не сказал — включать нечего проверять, и отказ говорит это.
    const refused = await post(
      `/partner/sim-cards/${sim.id}/status`,
      { status: 'active' },
      as(mine.token),
    );
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  });

  it('SIM с подтверждённым оператором партнёр включает сам', async () => {
    const msisdn = nextMsisdn();
    await declare(msisdn, operatorId);

    const sim = (await post('/partner/sim-cards', { operatorId, msisdn }, as(mine.token))).json<{
      sim: { id: string };
    }>().sim;

    const response = await post(
      `/partner/sim-cards/${sim.id}/status`,
      { status: 'active' },
      as(mine.token),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json<{ sim: { status: string } }>().sim.status).toBe('active');
  });

  it('заявленный оператор сверяется с источником, а не принимается на слово', async () => {
    const msisdn = nextMsisdn();
    // Источник говорит одно, партнёр объявляет другое: у всех тариф «безлимит внутри
    // своей сети», и такая ошибка — платный вызов за счёт самого партнёра.
    await declare(msisdn, silentOperatorId);

    const response = await post('/partner/sim-cards', { operatorId, msisdn }, as(mine.token));
    expect(response.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  });

  it('чужую SIM в свой порт не вставить', async () => {
    const gateway = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(neighbour.token))
    ).json<{ gateway: { id: string } }>().gateway.id;
    const port = (
      await post(`/partner/gateways/${gateway}/ports`, { portNumber: 1 }, as(neighbour.token))
    ).json<{ port: { id: string } }>().port.id;

    const response = await post(
      `/partner/gateway-ports/${port}/sim`,
      { simCardId: spareSim },
      as(neighbour.token),
    );
    expect(response.statusCode).toBe(404);
  });

  it('свою SIM в свой порт — вставляет', async () => {
    const gateway = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(mine.token))
    ).json<{ gateway: { id: string } }>().gateway.id;
    const port = (
      await post(`/partner/gateways/${gateway}/ports`, { portNumber: 1 }, as(mine.token))
    ).json<{ port: { id: string } }>().port.id;
    const sim = (
      await post('/partner/sim-cards', { operatorId, msisdn: nextMsisdn() }, as(mine.token))
    ).json<{ sim: { id: string } }>().sim.id;

    const response = await post(
      `/partner/gateway-ports/${port}/sim`,
      { simCardId: sim },
      as(mine.token),
    );
    expect(response.statusCode).toBe(201);

    // Состояние порта сообщает узел, а не мы: вставка SIM его не меняет. Проверяется
    // то, что действительно изменилось, — что в порту стоит именно эта карта.
    const equipment = (await get('/partner/equipment', as(mine.token))).json<EquipmentResponse>();
    const filled = equipment.gateways.find((row) => row.id === gateway);
    expect(filled?.ports[0]?.sim?.id).toBe(sim);
  });

  it('шлюз на восемь портов заводится сразу с портами 1–8', async () => {
    // Раньше число записывалось, а портов не появлялось: партнёр видел «портов не заведено»
    // и нажимал «добавить порт» восемь раз (владелец, 2026-09-24).
    const gateway = (
      await post(
        '/partner/gateways',
        { name: unique('Шлюз'), type: 'goip', portCount: 8 },
        as(mine.token),
      )
    ).json<{ gateway: { id: string } }>().gateway.id;

    const equipment = (await get('/partner/equipment', as(mine.token))).json<EquipmentResponse>();
    const created = equipment.gateways.find((row) => row.id === gateway);
    expect(created?.ports.map((port) => port.port_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('несколько портов добавляются разом — следующими номерами после последнего', async () => {
    const gateway = (
      await post(
        '/partner/gateways',
        { name: unique('Шлюз'), type: 'goip', portCount: 2 },
        as(mine.token),
      )
    ).json<{ gateway: { id: string } }>().gateway.id;

    const response = await post(`/partner/gateways/${gateway}/ports`, { count: 3 }, as(mine.token));
    expect(response.statusCode).toBe(201);
    expect(
      response.json<{ ports: { port_number: number }[] }>().ports.map((port) => port.port_number),
    ).toEqual([3, 4, 5]);

    const tooMany = await post(
      `/partner/gateways/${gateway}/ports`,
      { count: 252 },
      as(mine.token),
    );
    expect(tooMany.statusCode).toBe(409);
  });

  it('отдаёт, куда и под каким именем регистрировать шлюз — пароля нет', async () => {
    // Имя и сервер нужны партнёру при каждой перенастройке устройства, а были видны
    // только в минуту заведения. Пароль по-прежнему не отдаётся никогда.
    const response = await get('/partner/equipment', as(mine.token));
    const body = response.json<{
      connection: { server: string; port: number };
      gateways: { sip_username: string }[];
    }>();
    expect(body.connection.port).toBe(5060);
    expect(body.connection.server).not.toBe('');
    expect(body.gateways[0]?.sip_username).toMatch(/^gw-/u);
    expect(response.body).not.toContain('password');
    expect(response.body).not.toContain('a1_hash');
  });

  it('оператора карты площадка определяет по номеру сама', async () => {
    const msisdn = nextMsisdn();
    await declare(msisdn, operatorId);

    const response = await post('/partner/sim-cards', { msisdn }, as(mine.token));
    expect(response.statusCode).toBe(201);
    const sim = response.json<{ sim: { operator_id: string; operator_confirmed_at: string } }>()
      .sim;
    expect(sim.operator_id).toBe(operatorId);
    expect(sim.operator_confirmed_at).not.toBeNull();
  });

  it('без подтверждения оператором карты становится владелец диапазона — неподтверждённым', async () => {
    // Источник перенесённых номеров на площадке может быть не настроен, и тогда план
    // нумерации — всё, что известно. Карта заводится, но включить её без подтверждения
    // нельзя: номер мог уйти к другому оператору.
    const msisdn = '79430001234';
    await withDatabase(async (execute) => {
      await execute(sql`
        insert into numbering_plan_ranges
          (id, def_code, range_start, range_end, capacity, operator_id, region, source, imported_at)
        values (gen_random_uuid(), '943', 79430000000, 79430009999, 10000,
                ${operatorId}::uuid, 'Красноярский край', 'mincifry', now())
      `);
    });

    const response = await post('/partner/sim-cards', { msisdn }, as(mine.token));
    expect(response.statusCode).toBe(201);
    const sim = response.json<{
      sim: { operator_id: string; operator_confirmed_at: string | null };
    }>().sim;
    expect(sim.operator_id).toBe(operatorId);
    expect(sim.operator_confirmed_at).toBeNull();
  });

  it('номер, по которому оператор не определился, без оператора не заводится', async () => {
    // Угадывать нельзя: карта без подтверждённого оператора — платный вызов за счёт
    // партнёра. Лучше внятный отказ, чем тихая запись.
    const response = await post('/partner/sim-cards', { msisdn: nextMsisdn() }, as(mine.token));
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('dependency_unavailable');
  });

  it('транк партнёр не заводит: он привязан к узлу площадки', async () => {
    // Узлы — не его дело, и выбирать их ему нечем. Транк остаётся за администратором.
    const response = await post(
      '/partner/gateways',
      { name: unique('Транк'), type: 'sip_trunk' },
      as(mine.token),
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('партнёр распоряжается своим оборудованием', () => {
  it('списывает свой шлюз: железо у него, и когда оно уехало, знает он', async () => {
    const gateway = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(mine.token))
    ).json<{ gateway: { id: string } }>().gateway.id;

    const response = await post(
      `/partner/gateways/${gateway}/status`,
      { status: 'retired' },
      as(mine.token),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json<{ gateway: { status: string } }>().gateway.status).toBe('retired');

    // «Списал» значит «убрал»: строка остаётся в базе только потому, что на неё
    // ссылаются вызовы, а на рабочем экране ей делать нечего.
    const shown = (await get('/partner/equipment', as(mine.token))).json<EquipmentResponse>();
    expect(shown.gateways.map((row) => row.id)).not.toContain(gateway);
  });

  it('отключённый площадкой шлюз не списать: иначе рычаг обходится в два шага', async () => {
    const gateway = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(mine.token))
    ).json<{ gateway: { id: string } }>().gateway.id;
    expect((await post(`/gateways/${gateway}/status`, { status: 'suspended' })).statusCode).toBe(
      201,
    );

    // «Списал — завёл новый» — тот же обход отключения, только длиннее.
    const response = await post(
      `/partner/gateways/${gateway}/status`,
      { status: 'retired' },
      as(mine.token),
    );
    expect(response.statusCode).toBe(409);
  });

  it('карту в порту не списать, пока она в порту', async () => {
    const gateway = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(mine.token))
    ).json<{ gateway: { id: string } }>().gateway.id;
    const port = (
      await post(`/partner/gateways/${gateway}/ports`, { portNumber: 1 }, as(mine.token))
    ).json<{ port: { id: string } }>().port.id;
    const sim = (
      await post('/partner/sim-cards', { operatorId, msisdn: nextMsisdn() }, as(mine.token))
    ).json<{ sim: { id: string } }>().sim.id;
    expect(
      (await post(`/partner/gateway-ports/${port}/sim`, { simCardId: sim }, as(mine.token)))
        .statusCode,
    ).toBe(201);

    // Молча вынуть за партнёра было бы удобно ровно один раз и непонятно во все
    // остальные, когда карта исчезла из порта сама.
    const refused = await post(
      `/partner/sim-cards/${sim}/status`,
      { status: 'retired' },
      as(mine.token),
    );
    expect(refused.statusCode).toBe(409);

    // Вынул — списал.
    expect(
      (await post(`/partner/gateway-ports/${port}/sim`, { simCardId: null }, as(mine.token)))
        .statusCode,
    ).toBe(201);
    const retired = await post(
      `/partner/sim-cards/${sim}/status`,
      { status: 'retired' },
      as(mine.token),
    );
    expect(retired.statusCode).toBe(201);
    expect(retired.json<{ sim: { status: string } }>().sim.status).toBe('retired');
  });

  it('списание шлюза вынимает карты из его портов — иначе их не достать', async () => {
    const gateway = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(mine.token))
    ).json<{ gateway: { id: string } }>().gateway.id;
    const port = (
      await post(`/partner/gateways/${gateway}/ports`, { portNumber: 1 }, as(mine.token))
    ).json<{ port: { id: string } }>().port.id;
    const sim = (
      await post('/partner/sim-cards', { operatorId, msisdn: nextMsisdn() }, as(mine.token))
    ).json<{ sim: { id: string } }>().sim.id;
    expect(
      (await post(`/partner/gateway-ports/${port}/sim`, { simCardId: sim }, as(mine.token)))
        .statusCode,
    ).toBe(201);

    expect(
      (await post(`/partner/gateways/${gateway}/status`, { status: 'retired' }, as(mine.token)))
        .statusCode,
    ).toBe(201);

    // Порта больше нет — значит и карта больше не «стоит в порту». До этой правки
    // её нельзя было ни вынуть, ни списать, ни поставить в другой порт, и она
    // занимала место в пределе на количество.
    const retired = await post(
      `/partner/sim-cards/${sim}/status`,
      { status: 'retired' },
      as(mine.token),
    );
    expect(retired.statusCode).toBe(201);
  });

  it('карту из освобождённого порта можно поставить в другой шлюз', async () => {
    const first = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(mine.token))
    ).json<{ gateway: { id: string } }>().gateway.id;
    const firstPort = (
      await post(`/partner/gateways/${first}/ports`, { portNumber: 1 }, as(mine.token))
    ).json<{ port: { id: string } }>().port.id;
    const sim = (
      await post('/partner/sim-cards', { operatorId, msisdn: nextMsisdn() }, as(mine.token))
    ).json<{ sim: { id: string } }>().sim.id;
    expect(
      (await post(`/partner/gateway-ports/${firstPort}/sim`, { simCardId: sim }, as(mine.token)))
        .statusCode,
    ).toBe(201);
    expect(
      (await post(`/partner/gateways/${first}/status`, { status: 'retired' }, as(mine.token)))
        .statusCode,
    ).toBe(201);

    const second = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(mine.token))
    ).json<{ gateway: { id: string } }>().gateway.id;
    const secondPort = (
      await post(`/partner/gateways/${second}/ports`, { portNumber: 1 }, as(mine.token))
    ).json<{ port: { id: string } }>().port.id;

    const moved = await post(
      `/partner/gateway-ports/${secondPort}/sim`,
      { simCardId: sim },
      as(mine.token),
    );
    expect(moved.statusCode).toBe(201);
  });

  it('в порт списанного шлюза карту не поставить: порта больше нет', async () => {
    const gateway = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(mine.token))
    ).json<{ gateway: { id: string } }>().gateway.id;
    const port = (
      await post(`/partner/gateways/${gateway}/ports`, { portNumber: 1 }, as(mine.token))
    ).json<{ port: { id: string } }>().port.id;
    const sim = (
      await post('/partner/sim-cards', { operatorId, msisdn: nextMsisdn() }, as(mine.token))
    ).json<{ sim: { id: string } }>().sim.id;
    expect(
      (await post(`/partner/gateways/${gateway}/status`, { status: 'retired' }, as(mine.token)))
        .statusCode,
    ).toBe(201);

    const refused = await post(
      `/partner/gateway-ports/${port}/sim`,
      { simCardId: sim },
      as(mine.token),
    );
    expect(refused.statusCode).toBe(409);
  });

  it('один номер заводится сколько угодно раз, в том числе разными партнёрами', async () => {
    // Уникальность номера снята (ADR-0043, «Ревизия»): от вранья она не защищала,
    // а объявившему чужой номер первым позволяла не пустить на площадку настоящего
    // владельца карты.
    const msisdn = nextMsisdn();

    const first = await post('/partner/sim-cards', { operatorId, msisdn }, as(mine.token));
    expect(first.statusCode).toBe(201);

    const again = await post('/partner/sim-cards', { operatorId, msisdn }, as(mine.token));
    expect(again.statusCode).toBe(201);

    const neighbours = await post(
      '/partner/sim-cards',
      { operatorId, msisdn },
      as(neighbour.token),
    );
    expect(neighbours.statusCode).toBe(201);

    // Записи разные, номер один: это три строки, а не одна карта.
    const ids = [first, again, neighbours].map(
      (response) => response.json<{ sim: { id: string } }>().sim.id,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('чужую карту не списать', async () => {
    const response = await post(
      `/partner/sim-cards/${spareSim}/status`,
      { status: 'retired' },
      as(neighbour.token),
    );
    expect(response.statusCode).toBe(404);
  });

  it('заведение упирается в предел: человека, ограничивавшего объём, больше нет', async () => {
    // Свой партнёр, чтобы предел не зависел от того, сколько завели соседние проверки.
    const fresh = await createPartner('Сидоров Сидор');
    const limit = 12;

    for (let index = 0; index < limit; index += 1) {
      const created = await post(
        '/partner/gateways',
        { name: unique('Шлюз'), type: 'goip' },
        as(fresh.token),
      );
      expect(created.statusCode).toBe(201);
    }

    const refused = await post(
      '/partner/gateways',
      { name: unique('Лишний'), type: 'goip' },
      as(fresh.token),
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { details: { limit: number } } }>().error.details.limit).toBe(
      limit,
    );

    // Списанное не считается: предел про то, что стоит у партнёра сейчас.
    const first = (await get('/partner/equipment', as(fresh.token))).json<EquipmentResponse>()
      .gateways[0];
    expect(
      (
        await post(
          `/partner/gateways/${first?.id ?? ''}/status`,
          { status: 'retired' },
          as(fresh.token),
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (await post('/partner/gateways', { name: unique('Взамен'), type: 'goip' }, as(fresh.token)))
        .statusCode,
    ).toBe(201);
  });

  it('придержанную площадкой карту партнёр не включает — снимает администратор', async () => {
    const sim = (
      await post('/partner/sim-cards', { operatorId, msisdn: nextMsisdn() }, as(mine.token))
    ).json<{ sim: { id: string } }>().sim.id;
    expect((await post(`/sim-cards/${sim}/status`, { status: 'throttled' })).statusCode).toBe(201);

    // Придерживает порог отказов или администратор, и оба — решение площадки
    // (ADR-0047): включённая партнёром карта, пока старые отказы в окне, отключится снова.
    const refused = await post(
      `/partner/sim-cards/${sim}/status`,
      { status: 'active' },
      as(mine.token),
    );
    expect(refused.statusCode).toBe(409);
  });

  it('придержанную карту не списать и её номер заново не завести: иначе порог обходится', async () => {
    const msisdn = nextMsisdn();
    const sim = (await post('/partner/sim-cards', { operatorId, msisdn }, as(mine.token))).json<{
      sim: { id: string };
    }>().sim.id;
    expect((await post(`/sim-cards/${sim}/status`, { status: 'throttled' })).statusCode).toBe(201);

    // «Списал — завёл тот же номер заново — включил» вернул бы карту в работу без решения
    // площадки (ADR-0047).
    expect(
      (await post(`/partner/sim-cards/${sim}/status`, { status: 'retired' }, as(mine.token)))
        .statusCode,
    ).toBe(409);
    expect(
      (await post('/partner/sim-cards', { operatorId, msisdn }, as(mine.token))).statusCode,
    ).toBe(409);

    // Другой номер — пожалуйста: запрет про решение площадки по этой карте, а не про партнёра.
    expect(
      (await post('/partner/sim-cards', { operatorId, msisdn: nextMsisdn() }, as(mine.token)))
        .statusCode,
    ).toBe(201);
  });
});

describe('списанное окончательно и для площадки', () => {
  it('списанные шлюз и карту администратор тоже не возвращает', async () => {
    // Порты списанного шлюза освобождены, карты розданы по другим шлюзам: «ожившая» запись
    // стала бы шлюзом без портов и картой без истории (DOMAIN.md, «Жизненные циклы»).
    const gateway = (
      await post('/gateways', { partnerId: mine.id, name: unique('Шлюз'), type: 'goip' })
    ).json<{ gateway: { id: string } }>().gateway.id;
    expect((await post(`/gateways/${gateway}/status`, { status: 'retired' })).statusCode).toBe(201);
    expect((await post(`/gateways/${gateway}/status`, { status: 'active' })).statusCode).toBe(409);

    const sim = (
      await post('/sim-cards', { partnerId: mine.id, operatorId, msisdn: nextMsisdn() })
    ).json<{ sim: { id: string } }>().sim.id;
    expect((await post(`/sim-cards/${sim}/status`, { status: 'retired' })).statusCode).toBe(201);
    expect((await post(`/sim-cards/${sim}/status`, { status: 'active' })).statusCode).toBe(409);
  });
});

describe('транк не подчиняется контуру шлюзов (ADR-0047)', () => {
  /** Состояние и имя учётной записи транка — глазами администратора. */
  async function trunkAsAdmin(): Promise<{ status: string; sip_username: string }> {
    const trunks = (await get(`/sip-trunks?partnerId=${mine.id}`)).json<{
      trunks: { id: string; status: string; sip_username: string }[];
    }>().trunks;
    const found = trunks.find((trunk) => trunk.id === myTrunk);
    expect(found).toBeDefined();
    return { status: found?.status ?? '', sip_username: found?.sip_username ?? '' };
  }

  // Транк партнёру только показывается: заводит и настраивает его площадка, он привязан
  // к её узлу. Пути шлюзов проверяли владельца, но не вид, — и через них партнёр
  // выключал транк, перевыпускал ему доступ и заводил порты.
  it.each([
    [
      'status',
      () => post(`/partner/gateways/${myTrunk}/status`, { status: 'suspended' }, as(mine.token)),
    ],
    ['credentials', () => post(`/partner/gateways/${myTrunk}/credentials`, {}, as(mine.token))],
    ['ports', () => post(`/partner/gateways/${myTrunk}/ports`, { portNumber: 7 }, as(mine.token))],
  ])('%s — 404, как на чужой объект, и транк не меняется', async (_path, send) => {
    const before = await trunkAsAdmin();
    expect((await send()).statusCode).toBe(404);
    expect(await trunkAsAdmin()).toEqual(before);
  });

  it('портов у транка нет и у администратора', async () => {
    const response = await post(`/gateways/${myTrunk}/ports`, { portNumber: 1 });
    expect(response.statusCode).toBe(409);
  });
});

describe('кто выключил шлюз (ADR-0047)', () => {
  // Свой партнёр: у общего к этому месту уже упёрся предел на число шлюзов.
  let owner: Awaited<ReturnType<typeof createPartner>>;
  beforeAll(async () => {
    owner = await createPartner('Кузнецов Кузьма');
  });

  /** Свой шлюз, уже включённый: выключать можно только включённое. */
  async function ownActiveGateway(): Promise<string> {
    const id = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(owner.token))
    ).json<{ gateway: { id: string } }>().gateway.id;
    expect(
      (await post(`/partner/gateways/${id}/status`, { status: 'active' }, as(owner.token)))
        .statusCode,
    ).toBe(201);
    return id;
  }

  const setOwnStatus = (id: string, status: string) =>
    post(`/partner/gateways/${id}/status`, { status }, as(owner.token));

  /** Состояние шлюза глазами партнёра; списанный на экране не показывается. */
  async function partnerSees(
    id: string,
  ): Promise<{ status: string; suspended_by: string | null } | undefined> {
    const equipment = (await get('/partner/equipment', as(owner.token))).json<EquipmentResponse>();
    const found = equipment.gateways.find((row) => row.id === id);
    return found === undefined
      ? undefined
      : { status: found.status, suspended_by: found.suspended_by };
  }

  it('выключенный собой шлюз партнёр включает обратно сам', async () => {
    const id = await ownActiveGateway();

    expect((await setOwnStatus(id, 'suspended')).statusCode).toBe(201);
    expect(await partnerSees(id)).toEqual({ status: 'suspended', suspended_by: 'partner' });

    // До ADR-0047 здесь был `409`: выключение партнёра не отличалось от отключения
    // площадкой, и за одной кнопкой приходилось идти к человеку.
    expect((await setOwnStatus(id, 'active')).statusCode).toBe(201);
    expect(await partnerSees(id)).toEqual({ status: 'active', suspended_by: null });
  });

  it('выключенный собой шлюз партнёр и списывает сам', async () => {
    const id = await ownActiveGateway();
    expect((await setOwnStatus(id, 'suspended')).statusCode).toBe(201);

    expect((await setOwnStatus(id, 'retired')).statusCode).toBe(201);
    expect(await partnerSees(id)).toBeUndefined();
  });

  it('площадка запирает выключенный партнёром шлюз — дальше распоряжается только она', async () => {
    const id = await ownActiveGateway();
    expect((await setOwnStatus(id, 'suspended')).statusCode).toBe(201);

    // Тот же `suspended`, другой источник: так выключение становится необратимым для партнёра.
    expect((await post(`/gateways/${id}/status`, { status: 'suspended' })).statusCode).toBe(201);

    expect(await partnerSees(id)).toEqual({ status: 'suspended', suspended_by: 'platform' });
    expect((await setOwnStatus(id, 'active')).statusCode).toBe(409);
    expect((await setOwnStatus(id, 'retired')).statusCode).toBe(409);
  });

  it('отключение порогом партнёр видит отдельно и не снимает', async () => {
    const id = await ownActiveGateway();
    await withDatabase(async (execute) => {
      await execute(
        sql`update gateways set status = 'suspended', suspended_by = 'failure_threshold' where id = ${id}`,
      );
    });

    // Причина показана, потому что с ней партнёру есть что делать — проверить оборудование.
    expect(await partnerSees(id)).toEqual({
      status: 'suspended',
      suspended_by: 'failure_threshold',
    });
    const refused = await setOwnStatus(id, 'active');
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { details: { remedy: string } } }>().error.details.remedy).toMatch(
      /оборудование/u,
    );
  });

  it('кто именно на площадке выключил, партнёру не раскрывается', async () => {
    const id = await ownActiveGateway();
    expect((await post(`/gateways/${id}/status`, { status: 'suspended' })).statusCode).toBe(201);

    expect(await partnerSees(id)).toEqual({ status: 'suspended', suspended_by: 'platform' });

    // Администратору и поддержке — как есть: «выключил администратор» и «выключил порог»
    // для них разные разговоры.
    const admin = (await get(`/gateways?partnerId=${owner.id}`)).json<{
      gateways: { id: string; suspended_by: string | null }[];
    }>();
    expect(admin.gateways.find((row) => row.id === id)?.suspended_by).toBe('admin');
  });

  it('не выключает шлюз, который ещё не включён: выключать нечего', async () => {
    const id = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, as(owner.token))
    ).json<{ gateway: { id: string } }>().gateway.id;

    expect((await setOwnStatus(id, 'suspended')).statusCode).toBe(409);
  });

  it('журнал называет, кто выключил', async () => {
    const id = await ownActiveGateway();
    expect((await setOwnStatus(id, 'suspended')).statusCode).toBe(201);

    const entries = (
      await get(`/audit?entityType=gateway&entityId=${id}&action=gateway.status_changed`)
    ).json<{ entries: { actor_role: string | null; before: unknown; after: unknown }[] }>().entries;
    expect(entries).toContainEqual(
      expect.objectContaining({
        actor_role: 'partner',
        before: { status: 'active', suspended_by: null },
        after: { status: 'suspended', suspended_by: 'partner' },
      }),
    );
  });
});

describe('карты и порты при поздних и одновременных изменениях (ADR-0048)', () => {
  // Свой партнёр: у общего к этому месту уже упёрся предел на число шлюзов.
  let keeper: Awaited<ReturnType<typeof createPartner>>;
  beforeAll(async () => {
    keeper = await createPartner('Смирнов Семён');
  });

  const own = () => as(keeper.token);

  async function ownGatewayWithPort(): Promise<{ gateway: string; port: string }> {
    const gateway = (
      await post('/partner/gateways', { name: unique('Шлюз'), type: 'goip' }, own())
    ).json<{ gateway: { id: string } }>().gateway.id;
    const port = (await post(`/partner/gateways/${gateway}/ports`, { portNumber: 1 }, own())).json<{
      port: { id: string };
    }>().port.id;
    return { gateway, port };
  }

  async function ownSim(msisdn = nextMsisdn()): Promise<string> {
    const response = await post('/partner/sim-cards', { operatorId, msisdn }, own());
    expect(response.statusCode).toBe(201);
    return response.json<{ sim: { id: string } }>().sim.id;
  }

  async function simStatus(id: string): Promise<string> {
    return withDatabase(async (execute) => {
      const result = await execute(sql`select status from sim_cards where id = ${id}`);
      return (result.rows[0] as { status: string }).status;
    });
  }

  it('списанную карту в порт не поставить: списание окончательно', async () => {
    const { port } = await ownGatewayWithPort();
    const sim = await ownSim();
    expect(
      (await post(`/partner/sim-cards/${sim}/status`, { status: 'retired' }, own())).statusCode,
    ).toBe(201);

    // В порту она ожила бы для маршрутизации, хотя партнёр её уже отдал.
    const refused = await post(`/partner/gateway-ports/${port}/sim`, { simCardId: sim }, own());
    expect(refused.statusCode).toBe(409);
  });

  it('порт у списанного шлюза не завести — ни партнёру, ни администратору', async () => {
    const { gateway } = await ownGatewayWithPort();
    expect(
      (await post(`/partner/gateways/${gateway}/status`, { status: 'retired' }, own())).statusCode,
    ).toBe(201);

    expect(
      (await post(`/partner/gateways/${gateway}/ports`, { portNumber: 2 }, own())).statusCode,
    ).toBe(409);
    expect((await post(`/gateways/${gateway}/ports`, { portNumber: 3 })).statusCode).toBe(409);
  });

  it('вторую запись придержанного номера не включить: карта физически та же', async () => {
    const msisdn = nextMsisdn();
    await declare(msisdn, operatorId);
    // Обе записи заведены до придержания: номер не уникален (ADR-0043, «Ревизия»).
    const held = await ownSim(msisdn);
    const twin = await ownSim(msisdn);
    expect((await post(`/sim-cards/${held}/status`, { status: 'throttled' })).statusCode).toBe(201);

    const refused = await post(`/partner/sim-cards/${twin}/status`, { status: 'active' }, own());
    expect(refused.statusCode).toBe(409);
    expect(await simStatus(twin)).toBe('new');
  });

  it.each([
    ['включение', 'active'],
    ['списание', 'retired'],
  ] as const)(
    '%s своей карты не затирает придержание, поставленное в тот же момент',
    async (_action, status) => {
      const msisdn = nextMsisdn();
      await declare(msisdn, operatorId);
      const sim = await ownSim(msisdn);

      // Площадка придерживает карту, пока обращение партнёра ещё в пути: транзакция
      // держателя не зафиксирована, и партнёр прочтёт карту прежней.
      const holder = await holdTransaction(
        sql`update sim_cards set status = 'throttled' where id = ${sim}`,
      );
      try {
        const changing = post(`/partner/sim-cards/${sim}/status`, { status }, own());
        expect(await waitUntilBlocked({ blockedBy: [holder.pid], until: changing })).not.toBe(
          'settled',
        );
        await holder.release();

        expect((await changing).statusCode).toBe(409);
        expect(await simStatus(sim)).toBe('throttled');
      } finally {
        await holder.release();
      }
    },
  );
});
