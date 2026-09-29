/**
 * Вызов идёт только на партнёра, покрывающего регион номера (ADR-0022).
 *
 * Проверяется на реальной базе: правило «списка нет — подходит любой регион» выражено
 * в SQL через `bool_or` по пустому множеству и `coalesce`, а неизвестный регион —
 * через `is not distinct from`. Подставным репозиторием проверялось бы не поведение
 * PostgreSQL, а моё представление о нём — ровно там, где ошибка стоит денег партнёра.
 *
 * Отдельно проверяется, что отказ **отличим**: «нет SIM вовсе» и «SIM есть, но регион
 * не покрыт» — разные причины и разные коды SIP.
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
  return `79${String(400000000 + msisdnCounter).slice(0, 9)}`;
};

async function post(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url, headers: auth(), payload });
}

async function put(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'PUT', url, headers: auth(), payload });
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

/** Оператор нужен свой у каждой проверки: иначе чужие SIM попадают в кандидаты. */
async function createOperator(): Promise<string> {
  const response = await post('/operators', { name: unique('Оператор') });
  return response.json<{ operator: { id: string } }>().operator.id;
}

interface Partner {
  readonly id: string;
  readonly simId: string;
}

/** Подтверждённый партнёр со шлюзом, портом и активной SIM нужного оператора. */
async function createPartner(operatorId: string): Promise<Partner> {
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
  await post(`/gateway-ports/${port}/sim`, { simCardId: sim });

  await post('/partner-rates', {
    partnerId: partner,
    operatorId,
    pricePerMinute: '1',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });

  return { id: partner, simId: sim };
}

/** Клиент с активным каналом и деньгами. */
async function createChannel(): Promise<string> {
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

  return channel;
}

/**
 * Номер с известным оператором и, возможно, известным регионом.
 *
 * `region = null` — не выдумка ради проверки: внешний источник отвечает без региона,
 * а в плане нумерации он местами пуст.
 */
async function createDestination(operatorId: string, region: string | null): Promise<string> {
  const destination = nextMsisdn();
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into number_resolutions (id, msisdn, operator_id, region, source, resolved_at, expires_at)
      values (gen_random_uuid()::text::uuid, ${destination}, ${operatorId}, ${region}, 'manual', now(), now() + interval '30 days')
    `);
  });
  return destination;
}

interface Preview {
  outcome: string;
  reason: string | null;
  sip_response: string | null;
  candidates: { sim_card_id: string }[];
}

/** Маршрут с теми же побочными действиями, что и настоящий. */
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

async function setCoverage(partnerId: string, regions: string[]) {
  return put(`/partners/${partnerId}/coverage`, { regions });
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
  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  token = login.json<{ token: string }>().token;

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
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('отбор по покрытию', () => {
  it('партнёр без списка принимает вызов в любой регион', async () => {
    // Иначе новый партнёр не принял бы ни одного вызова, пока кто-то не заполнит
    // список, и это выглядело бы поломкой платформы, а не его настройкой.
    const operator = await createOperator();
    const partner = await createPartner(operator);
    const channel = await createChannel();

    const preview = await route(channel, await createDestination(operator, 'Красноярский край'));
    expect(preview.outcome).toBe('routed');
    expect(preview.candidates[0]?.sim_card_id).toBe(partner.simId);
  }, 120_000);

  it('партнёр со списком принимает вызов в объявленный регион', async () => {
    const operator = await createOperator();
    const partner = await createPartner(operator);
    const channel = await createChannel();

    expect((await setCoverage(partner.id, ['Красноярский край'])).statusCode).toBe(200);

    const preview = await route(channel, await createDestination(operator, 'Красноярский край'));
    expect(preview.outcome).toBe('routed');
    expect(preview.candidates[0]?.sim_card_id).toBe(partner.simId);
  }, 120_000);

  it('не отдаёт вызов в регион, которого партнёр не объявлял', async () => {
    const operator = await createOperator();
    const partner = await createPartner(operator);
    const channel = await createChannel();

    await setCoverage(partner.id, ['Красноярский край']);

    const preview = await route(channel, await createDestination(operator, 'Москва'));
    expect(preview.outcome).toBe('rejected');
    // Отдельная причина: «SIM есть, но регион не покрыт» и «SIM нет вовсе» — разные
    // разговоры с партнёром и разные коды SIP.
    expect(preview.reason).toBe('no_coverage');
    expect(preview.sip_response).toBe('503 Service Unavailable');
  }, 120_000);

  it('написание региона не мешает совпадению', async () => {
    // Партнёр пишет «Красноярский кр.», источник отвечает «Красноярский край».
    // Сравнение строк напрямую означало бы отказ там, где покрытие объявлено.
    const operator = await createOperator();
    const partner = await createPartner(operator);
    const channel = await createChannel();

    await setCoverage(partner.id, ['Красноярский кр.']);

    const preview = await route(channel, await createDestination(operator, 'КРАСНОЯРСКИЙ КРАЙ'));
    expect(preview.outcome).toBe('routed');
  }, 120_000);

  it('пустой список снимает ограничение', async () => {
    const operator = await createOperator();
    const partner = await createPartner(operator);
    const channel = await createChannel();

    await setCoverage(partner.id, ['Красноярский край']);
    expect((await route(channel, await createDestination(operator, 'Москва'))).outcome).toBe(
      'rejected',
    );

    expect((await setCoverage(partner.id, [])).statusCode).toBe(200);
    expect((await route(channel, await createDestination(operator, 'Москва'))).outcome).toBe(
      'routed',
    );
  }, 120_000);
});

describe('неизвестный регион', () => {
  it('не отдаётся партнёру со списком: покрытие не доказано', async () => {
    const operator = await createOperator();
    const partner = await createPartner(operator);
    const channel = await createChannel();

    await setCoverage(partner.id, ['Красноярский край']);

    const preview = await route(channel, await createDestination(operator, null));
    expect(preview.outcome).toBe('rejected');
    expect(preview.reason).toBe('no_coverage');
  }, 120_000);

  it('отдаётся партнёру без списка: он сам сказал, что регион ему безразличен', async () => {
    const operator = await createOperator();
    const partner = await createPartner(operator);
    const channel = await createChannel();

    const preview = await route(channel, await createDestination(operator, null));
    expect(preview.outcome).toBe('routed');
    expect(preview.candidates[0]?.sim_card_id).toBe(partner.simId);
  }, 120_000);

  it('название без региона в нём не считается известным регионом', async () => {
    // «Область» региона не называет: ключ пустой. Считать такой ответ источника
    // известным регионом значит выдать маршрут по несуществующему покрытию.
    const operator = await createOperator();
    const partner = await createPartner(operator);
    const channel = await createChannel();

    await setCoverage(partner.id, ['Красноярский край']);

    const preview = await route(channel, await createDestination(operator, 'область'));
    expect(preview.reason).toBe('no_coverage');
  }, 120_000);
});

describe('отказ остаётся различимым', () => {
  it('без единой SIM с ценой на номер — «нет тарифа», а не «нет покрытия»', async () => {
    const operator = await createOperator();
    const channel = await createChannel();

    // Карты других проверок на узле есть, но цены на этого оператора нет ни у одной:
    // куда SIM звонит, решает её тариф (ADR-0056). Это разговор о тарифах партнёров,
    // а не о покрытии регионов.
    const preview = await route(channel, await createDestination(operator, 'Москва'));
    expect(preview.outcome).toBe('rejected');
    expect(preview.reason).toBe('no_tariff');
  }, 120_000);
});

describe('управление покрытием', () => {
  it('заменяет список целиком, а не дополняет его', async () => {
    const operator = await createOperator();
    const partner = await createPartner(operator);

    await setCoverage(partner.id, ['Красноярский край', 'Москва']);
    const replaced = await setCoverage(partner.id, ['Москва']);

    expect(replaced.json<{ regions: { region: string; region_key: string }[] }>().regions).toEqual([
      { region: 'Москва', region_key: 'москва' },
    ]);
  }, 120_000);

  it('отвергает строку, которая региона не называет', async () => {
    const operator = await createOperator();
    const partner = await createPartner(operator);

    const response = await setCoverage(partner.id, ['область']);
    expect(response.statusCode).toBe(400);
  }, 120_000);

  it('отвергает два написания одного региона', async () => {
    // Молча схлопнуть их значит вернуть партнёру не тот список, который он задал.
    const operator = await createOperator();
    const partner = await createPartner(operator);

    const response = await setCoverage(partner.id, ['Красноярский край', 'Красноярский кр.']);
    expect(response.statusCode).toBe(400);
  }, 120_000);

  it('отвечает «не найдено» на неизвестного партнёра', async () => {
    const response = await setCoverage('01a00000-0000-7000-8000-000000000000', ['Москва']);
    expect(response.statusCode).toBe(404);
  }, 120_000);

  it('клиенту покрытие партнёра не показывается вовсе', async () => {
    // Покрытие — свойство партнёра, а партнёра клиент знает только под псевдонимом
    // (ADR-0014). Роль здесь первый рубеж, и он же единственный: клиентского
    // представления у покрытия нет.
    const operator = await createOperator();
    const partner = await createPartner(operator);

    const clientUser = uniqueEmail();
    const { IdentityService } = await import('../identity/identity.service.js');
    await api().get(IdentityService).createByAdmin({
      email: clientUser,
      password: TEST_PASSWORD,
      fullName: 'Клиент',
      role: 'client',
      status: 'active',
    });
    const login = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: clientUser, password: TEST_PASSWORD },
    });
    const clientToken = login.json<{ token: string }>().token;

    const response = await api().inject({
      method: 'GET',
      url: `/partners/${partner.id}/coverage`,
      headers: { authorization: `Bearer ${clientToken}` },
    });
    expect(response.statusCode).toBe(403);
  }, 120_000);

  it('поддержка читает список, но не меняет его', async () => {
    const operator = await createOperator();
    const partner = await createPartner(operator);
    await setCoverage(partner.id, ['Москва']);

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
    const supportToken = login.json<{ token: string }>().token;
    const headers = { authorization: `Bearer ${supportToken}` };

    const listed = await api().inject({
      method: 'GET',
      url: `/partners/${partner.id}/coverage`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ regions: { region: string }[] }>().regions).toHaveLength(1);

    const changed = await api().inject({
      method: 'PUT',
      url: `/partners/${partner.id}/coverage`,
      headers,
      payload: { regions: [] },
    });
    expect(changed.statusCode).toBe(403);
  }, 120_000);

  it('диапазон на два субъекта подходит объявившему любой из них', async () => {
    // Каждый седьмой диапазон плана нумерации выделен на два субъекта, и в источнике
    // они перечислены в произвольном порядке (ADR-0033). Партнёр, объявивший «Москва»,
    // до этого не получал ни одного из 1042 московских диапазонов.
    const operator = await createOperator();
    const partner = await createPartner(operator);
    await setCoverage(partner.id, ['Москва']);

    for (const region of ['Город Москва, Московская область', 'Московская область, Город Москва']) {
      const response = await get(
        `/routing/sim-candidates?operatorId=${operator}&region=${encodeURIComponent(region)}`,
      );
      expect(response.json<{ candidates: unknown[] }>().candidates, region).toHaveLength(1);
    }
  }, 120_000);

  it('объявивший второй субъект пары подходит тоже', async () => {
    const operator = await createOperator();
    const partner = await createPartner(operator);
    await setCoverage(partner.id, ['Московская область']);

    const response = await get(
      `/routing/sim-candidates?operatorId=${operator}&region=${encodeURIComponent('Город Москва, Московская область')}`,
    );
    expect(response.json<{ candidates: unknown[] }>().candidates).toHaveLength(1);
  }, 120_000);

  it('альтернативное имя субъекта через тире совпадает с обычным', async () => {
    // Официальные названия четырёх субъектов содержат два имени: «Кемеровская область -
    // Кузбасс». Склеенные в один ключ, они не совпадали ни с одним написанием партнёра.
    const operator = await createOperator();
    const kemerovo = await createPartner(operator);
    await setCoverage(kemerovo.id, ['Кемеровская область']);

    const response = await get(
      `/routing/sim-candidates?operatorId=${operator}&region=${encodeURIComponent('Кемеровская область - Кузбасс')}`,
    );
    expect(response.json<{ candidates: unknown[] }>().candidates).toHaveLength(1);
  }, 120_000);

  it('соседний субъект по-прежнему не подходит', async () => {
    // Пересечение наборов не должно превратиться в «подходит всё»: диапазон,
    // выделенный на Москву с областью, к красноярскому партнёру не идёт.
    const operator = await createOperator();
    const partner = await createPartner(operator);
    await setCoverage(partner.id, ['Красноярский край']);

    const response = await get(
      `/routing/sim-candidates?operatorId=${operator}&region=${encodeURIComponent('Город Москва, Московская область')}`,
    );
    expect(response.json<{ candidates: unknown[] }>().candidates).toHaveLength(0);
  }, 120_000);

  it('вся страна регионом не считается: это «регион неизвестен»', async () => {
    // 37 диапазонов выделены на «Российскую Федерацию». Партнёр со списком такой вызов
    // не принимает — покрытие не доказано (правило 2 ADR-0022).
    const operator = await createOperator();
    const listed = await createPartner(operator);
    await setCoverage(listed.id, ['Москва']);

    const response = await get(
      `/routing/sim-candidates?operatorId=${operator}&region=${encodeURIComponent('Российская Федерация')}`,
    );
    expect(response.json<{ candidates: unknown[] }>().candidates).toHaveLength(0);
  }, 120_000);

  it('разбор «какие SIM подходят» учитывает регион, если его назвали', async () => {
    const operator = await createOperator();
    const partner = await createPartner(operator);
    await setCoverage(partner.id, ['Москва']);

    const everywhere = await get(`/routing/sim-candidates?operatorId=${operator}`);
    expect(everywhere.json<{ candidates: unknown[] }>().candidates).toHaveLength(1);

    const covered = await get(`/routing/sim-candidates?operatorId=${operator}&region=Москва`);
    expect(covered.json<{ candidates: unknown[] }>().candidates).toHaveLength(1);

    const foreign = await get(
      `/routing/sim-candidates?operatorId=${operator}&region=${encodeURIComponent('Красноярский край')}`,
    );
    expect(foreign.json<{ candidates: unknown[] }>().candidates).toHaveLength(0);
  }, 120_000);
});
