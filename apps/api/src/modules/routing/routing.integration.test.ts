/**
 * Маршрутизация вызова на реальной базе (ARCHITECTURE.md, ADR-0010, ADR-0013).
 *
 * Здесь проверяются два инварианта, которые не проверяются больше нигде и стоят денег:
 * одновременность на SIM и резерв средств до звонка. Оба держатся на блокировках
 * в транзакции, то есть без настоящей PostgreSQL не проверяются вовсе.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  registerGateway,
  registerPort,
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
  return `79${String(200000000 + msisdnCounter).slice(0, 9)}`;
};

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

async function post(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url, headers: auth(), payload });
}

/**
 * Полностью готовое окружение вызова: подтверждённый партнёр со шлюзом, портом
 * и активной SIM; активный клиент с деньгами, каналом и тарифом.
 */
async function scenario(
  options: {
    recordingRequired?: boolean;
    gatewayType?: 'goip' | 'android';
    deposit?: string;
    /** Вход по линиям (ADR-0054): регистрируется порт, а не шлюз. */
    registrationMode?: 'gateway' | 'port';
    /** Не регистрировать ни шлюз, ни линию — для проверки отбора по регистрации. */
    unregistered?: boolean;
  } = {},
) {
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
    await post('/gateways', {
      partnerId: partner,
      name: unique('Шлюз'),
      type: options.gatewayType ?? 'goip',
      ...(options.registrationMode === undefined
        ? {}
        : { registrationMode: options.registrationMode }),
    })
  ).json<{ gateway: { id: string }; account: { username: string } }>();
  await post(`/gateways/${gateway.gateway.id}/status`, { status: 'active' });

  const port = (await post(`/gateways/${gateway.gateway.id}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;

  // Маршрутизация выбирает только шлюзы, зарегистрированные на принявшем вызов узле;
  // при входе по линиям — только линии, зарегистрированные на нём (ADR-0054).
  if (options.registrationMode === 'port') {
    await post(`/gateways/${gateway.gateway.id}/port-credentials`, {});
    if (options.unregistered !== true) await registerPort(api(), nodeKey, port);
  } else if (options.unregistered !== true) {
    await registerGateway(api(), nodeKey, gateway.gateway.id);
  }

  const sim = (
    await post('/sim-cards', { partnerId: partner, operatorId: operator, msisdn: nextMsisdn() })
  ).json<{ sim: { id: string } }>().sim.id;
  await post(`/sim-cards/${sim}/status`, { status: 'active' });
  await post(`/gateway-ports/${port}/sim`, { simCardId: sim });

  const channel = (
    await post('/channels', {
      clientId: client,
      name: unique('Линия'),
      recordingRequired: options.recordingRequired ?? false,
    })
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
    amount: options.deposit ?? '1000',
    idempotencyKey: unique('deposit'),
    description: 'Пополнение под проверку',
  });

  // Номер назначения объявляется тем же оператором: резолвер в тестах внешний источник
  // не дёргает, поэтому запись заводится напрямую как подтверждённая.
  const destination = nextMsisdn();
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into number_resolutions (id, msisdn, operator_id, source, resolved_at, expires_at)
      values (gen_random_uuid()::text::uuid, ${destination}, ${operator}, 'manual', now(), now() + interval '30 days')
    `);
  });

  return { operator, partner, client, sim, port, channel, destination, gateway };
}

interface Preview {
  outcome: string;
  reason: string | null;
  sip_response: string | null;
  call_id: string | null;
  candidates: { sim_card_id: string; sip_username: string; line_prefix: string | null }[];
}

async function route(channel: string, destination: string, callId = unique('call')) {
  return post('/routing/preview', { callId, channelId: channel, nodeId, destination });
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

  const node = await post('/nodes', { name: unique('Узел') });
  nodeId = node.json<{ node: { id: string } }>().node.id;

  // Узел доводится до рабочего ключа: без него нечем отметить регистрацию шлюза,
  // а без регистрации маршрутизация его не выберет.
  const command = node.json<{ install: { command: string } }>().install.command;
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

describe('вход по линиям GOIP (ADR-0054)', () => {
  it('набирается вход линии, где стоит SIM, без префикса', async () => {
    const env = await scenario({ registrationMode: 'port' });
    const decision = (await route(env.channel, env.destination)).json<Preview>();

    expect(decision.outcome).toBe('routed');
    expect(decision.candidates[0]?.sim_card_id).toBe(env.sim);
    expect(decision.candidates[0]?.sip_username).toMatch(/^pt-[a-z0-9]{12}$/);
    expect(decision.candidates[0]?.line_prefix).toBeNull();
  });

  it('линия без регистрации — не кандидат, и отказ говорит о железе', async () => {
    // Шлюз включён и SIM в порту, но линия ни разу не регистрировалась: набрать её
    // нечем. Регистрация самого шлюза здесь ничего не значит — он её и не получит.
    const env = await scenario({ registrationMode: 'port', unregistered: true });
    const decision = (await route(env.channel, env.destination)).json<Preview>();

    expect(decision.outcome).toBe('rejected');
    expect(decision.reason).toBe('gateway_unregistered');
  });

  it('узел набирает `user/pt-…` через диалплан', async () => {
    const env = await scenario({ registrationMode: 'port' });
    const response = await api().inject({
      method: 'POST',
      url: '/node/dialplan',
      headers: {
        authorization: `Bearer ${nodeKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        section: 'dialplan',
        'Unique-ID': unique('call'),
        variable_zvonix_channel: env.channel,
        'Caller-Destination-Number': env.destination,
      }).toString(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(
      new RegExp(`\\[sip_invite_req_uri=sip:${env.destination}@[^\\]]+\\]user/pt-[a-z0-9]{12}@`),
    );
    expect(response.body).not.toContain('user/gw-');
  });
});

describe('успешный маршрут', () => {
  it('выдаёт кандидата, создаёт вызов и придерживает деньги', async () => {
    const env = await scenario();
    const response = await route(env.channel, env.destination);
    expect(response.statusCode).toBe(201);

    const decision = response.json<Preview>();
    expect(decision.outcome).toBe('routed');
    expect(decision.candidates).toHaveLength(1);
    expect(decision.candidates[0]?.sim_card_id).toBe(env.sim);
    // SIM стоит в порту 1 GOIP: узел выберет её линию префиксом (ADR-0053).
    expect(decision.candidates[0]?.line_prefix).toBe('99001');

    const held = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select coalesce(sum(amount), 0)::text as total from reservations
             where client_id = ${env.client} and status = 'held'`,
      );
      return BigInt((result.rows[0] as { total: string }).total);
    });
    // Резерв — стоимость разговора предельной длительности: час по рублю за минуту.
    expect(held).toBe(60_000_000n);
  });

  it('повторный запрос по тому же вызову не придерживает деньги дважды', async () => {
    const env = await scenario();
    const callId = unique('call');
    await route(env.channel, env.destination, callId);
    const again = await route(env.channel, env.destination, callId);
    expect(again.json<Preview>().outcome).toBe('routed');

    const count = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as n from reservations where client_id = ${env.client}`,
      );
      return (result.rows[0] as { n: number }).n;
    });
    // Узел может переспросить. Второй резерв означал бы, что деньги придержаны
    // дважды за одно и то же.
    expect(count).toBe(1);
  });
});

describe('повтор запроса по тому же вызову', () => {
  it('возвращает тот же маршрут, даже если SIM успели заблокировать', async () => {
    // Маршрут уже выдан, место на SIM занято, деньги придержаны. Отбирать кандидатов
    // заново значит проверять состояния, которые с тех пор изменились, — и вернуть
    // «маршрут» без единого кандидата, то есть диалплан, по которому некуда звонить.
    const s = await scenario();
    const callId = unique('call');

    const first = (await route(s.channel, s.destination, callId)).json<Preview>();
    expect(first.outcome).toBe('routed');

    await post(`/sim-cards/${s.sim}/status`, { status: 'blocked' });

    const second = (await route(s.channel, s.destination, callId)).json<Preview>();
    expect(second.outcome).toBe('routed');
    expect(second.candidates.map((candidate) => candidate.sim_card_id)).toEqual([s.sim]);
  });

  it('отвечает внутренней ошибкой, если SIM вынули из порта', async () => {
    // Воспроизвести маршрут нечем: без порта неизвестно, через какой шлюз звонить.
    const s = await scenario();
    const callId = unique('call');
    expect((await route(s.channel, s.destination, callId)).json<Preview>().outcome).toBe('routed');

    await post(`/gateway-ports/${s.port}/sim`, { simCardId: null });

    const second = (await route(s.channel, s.destination, callId)).json<Preview>();
    expect(second.outcome).toBe('rejected');
    expect(second.reason).toBe('internal_error');
  });
});

describe('одновременность на SIM', () => {
  it('второй вызов на занятую SIM не проходит', async () => {
    const env = await scenario();
    expect((await route(env.channel, env.destination)).json<Preview>().outcome).toBe('routed');

    const second = await route(env.channel, env.destination);
    // По умолчанию SIM обслуживает один вызов: превышение — прямой путь
    // к её блокировке оператором.
    expect(second.json<Preview>().reason).toBe('no_sim_available');
  });

  it('одновременные запросы не пробивают предел', async () => {
    const env = await scenario();

    const attempts = await Promise.all([
      route(env.channel, env.destination),
      route(env.channel, env.destination),
      route(env.channel, env.destination),
    ]);
    const routed = attempts.filter((r) => r.json<Preview>().outcome === 'routed');

    // Без блокировки SIM все три насчитали бы ноль открытых вызовов и все три прошли.
    expect(routed).toHaveLength(1);
  });

  it('поднятый администратором предел пропускает больше вызовов', async () => {
    const env = await scenario();
    await post(`/sim-cards/${env.sim}/concurrency`, { maxConcurrentCalls: 2 });

    expect((await route(env.channel, env.destination)).json<Preview>().outcome).toBe('routed');
    expect((await route(env.channel, env.destination)).json<Preview>().outcome).toBe('routed');
    expect((await route(env.channel, env.destination)).json<Preview>().reason).toBe(
      'no_sim_available',
    );
  });

  it('вызов без CDR не занимает SIM вечно', async () => {
    const env = await scenario();
    const first = await route(env.channel, env.destination);
    expect(first.json<Preview>().outcome).toBe('routed');
    // Место занято: узел ещё не отчитался.
    expect((await route(env.channel, env.destination)).json<Preview>().reason).toBe(
      'no_sim_available',
    );

    // Узел умер, не прислав CDR: отматываем начало вызова за предельную длительность.
    await withDatabase(async (execute) => {
      await execute(sql`update calls set started_at = now() - interval '3 hours'
                         where id = ${first.json<Preview>().call_id}`);
    });

    // Резерв освободился бы по сроку сам, а место на SIM — нет: без уборки
    // эта SIM больше не приняла бы ни одного звонка.
    expect((await route(env.channel, env.destination)).json<Preview>().outcome).toBe('routed');

    const closed = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select status, failure_reason from calls where id = ${first.json<Preview>().call_id}`,
      );
      return result.rows[0] as { status: string; failure_reason: string };
    });
    expect(closed.status).toBe('failed');
    // Отдельная причина, а не общая внутренняя ошибка: это диагноз узла.
    expect(closed.failure_reason).toBe('node_lost');
  });

  it('завершённый вызов освобождает место', async () => {
    const env = await scenario();
    const first = await route(env.channel, env.destination);
    const callId = first.json<Preview>().call_id;

    await withDatabase(async (execute) => {
      await execute(sql`update calls set status = 'completed' where id = ${callId}`);
    });

    expect((await route(env.channel, env.destination)).json<Preview>().outcome).toBe('routed');
  });
});

describe('деньги', () => {
  it('без средств на резерв вызов не состоится', async () => {
    // Резерв — стоимость часа разговора, то есть 60 ₽. На счету десять.
    const env = await scenario({ deposit: '10' });
    const decision = (await route(env.channel, env.destination)).json<Preview>();

    expect(decision.reason).toBe('insufficient_funds');
    expect(decision.sip_response).toBe('402 Payment Required');
  });

  it('отказ по деньгам освобождает место на SIM', async () => {
    const env = await scenario({ deposit: '10' });
    expect((await route(env.channel, env.destination)).json<Preview>().reason).toBe(
      'insufficient_funds',
    );

    await post(`/clients/${env.client}/deposit`, {
      amount: '1000',
      idempotencyKey: unique('deposit'),
      description: 'Доплата',
    });

    // Место не должно остаться занятым несостоявшимся вызовом.
    expect((await route(env.channel, env.destination)).json<Preview>().outcome).toBe('routed');
  });

  it('резервы копятся и вместе ограничивают доступное', async () => {
    // Хватает ровно на два резерва по 60 ₽; SIM пропускает три вызова.
    const env = await scenario({ deposit: '130' });
    await post(`/sim-cards/${env.sim}/concurrency`, { maxConcurrentCalls: 3 });

    expect((await route(env.channel, env.destination)).json<Preview>().outcome).toBe('routed');
    expect((await route(env.channel, env.destination)).json<Preview>().outcome).toBe('routed');
    expect((await route(env.channel, env.destination)).json<Preview>().reason).toBe(
      'insufficient_funds',
    );
  });

  it('овердрафт увеличивает доступное', async () => {
    const env = await scenario({ deposit: '10' });
    await withDatabase(async (execute) => {
      await execute(sql`update clients set overdraft_limit = 100000000 where id = ${env.client}`);
    });

    expect((await route(env.channel, env.destination)).json<Preview>().outcome).toBe('routed');
  });

  it('без тарифа вызов не состоится: минуты SIM партнёр тратит в любом случае', async () => {
    const env = await scenario();
    await withDatabase(async (execute) => {
      await execute(sql`delete from partner_rates where partner_id = ${env.partner}`);
    });

    expect((await route(env.channel, env.destination)).json<Preview>().reason).toBe('no_tariff');
  });
});

describe('отказы', () => {
  it('неподтверждённый оператор — отказ, а не догадка', async () => {
    const env = await scenario();
    // Номер, которого нет в базе разрешений: внешний источник в тестах отключён.
    const decision = (await route(env.channel, '79998887766')).json<Preview>();

    expect(decision.reason).toBe('operator_unconfirmed');
    expect(decision.sip_response).toBe('404 Not Found');
  });

  it('нет SIM нужного оператора — отказ', async () => {
    const env = await scenario();
    await post(`/sim-cards/${env.sim}/status`, { status: 'blocked' });

    expect((await route(env.channel, env.destination)).json<Preview>().reason).toBe(
      'no_sim_available',
    );
  });

  it('канал с записью не уходит на android, и причина отличается от «нет SIM»', async () => {
    const env = await scenario({ gatewayType: 'android', recordingRequired: true });
    const decision = (await route(env.channel, env.destination)).json<Preview>();

    // Для поддержки это два разных разговора с партнёром, поэтому и причины разные.
    expect(decision.reason).toBe('recording_required');
  });

  it('неизвестный канал — отказ, и вызов не записывается', async () => {
    const before = await withDatabase(async (execute) => {
      const result = await execute(sql`select count(*)::int as n from calls`);
      return (result.rows[0] as { n: number }).n;
    });

    const decision = (
      await post('/routing/preview', {
        callId: unique('call'),
        channelId: crypto.randomUUID(),
        nodeId,
        destination: '79001234567',
      })
    ).json<Preview>();

    expect(decision.reason).toBe('channel_unknown');
    expect(decision.call_id).toBeNull();

    // Записать не к чему: у вызова канал обязателен, а строка без канала не отвечает
    // ни на один вопрос, ради которого вызовы и пишутся.
    const after = await withDatabase(async (execute) => {
      const result = await execute(sql`select count(*)::int as n from calls`);
      return (result.rows[0] as { n: number }).n;
    });
    expect(after).toBe(before);
  });

  it('отказ записывается вызовом с причиной: иначе разбирать нечего', async () => {
    const env = await scenario();
    const decision = (await route(env.channel, '79998887755')).json<Preview>();
    expect(decision.call_id).not.toBeNull();

    const stored = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select status, failure_reason from calls where id = ${decision.call_id}`,
      );
      return result.rows[0] as { status: string; failure_reason: string };
    });
    expect(stored.status).toBe('failed');
    expect(stored.failure_reason).toBe('operator_unconfirmed');
  });

  it('короткий номер получает свой диагноз, а не «оператор не подтверждён»', async () => {
    const env = await scenario();
    const decision = (await route(env.channel, '112')).json<Preview>();

    // До определения оператора такой вызов не доходит, и называть отказ его именем
    // значит отправлять поддержку разбирать резолвер, которого не спрашивали (ADR-0042).
    expect(decision.reason).toBe('destination_invalid');
    expect(decision.sip_response).toBe('404 Not Found');
  });

  it('вызов на короткий номер записывается — иначе причине не к чему относиться', async () => {
    const env = await scenario();
    const decision = (await route(env.channel, '112')).json<Preview>();
    expect(decision.call_id).not.toBeNull();

    const stored = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select status, failure_reason, destination, operator_id from calls where id = ${decision.call_id}`,
      );
      return result.rows[0] as {
        status: string;
        failure_reason: string;
        destination: string;
        operator_id: string | null;
      };
    });

    expect(stored.status).toBe('failed');
    expect(stored.failure_reason).toBe('destination_invalid');
    // Единственное место, где в назначении не канонический номер: канонического
    // вида у набранного и не получилось.
    expect(stored.destination).toBe('112');
    // Оператора не спрашивали: отказ произошёл раньше.
    expect(stored.operator_id).toBeNull();
  });

  it('служебный набор доезжает до вызова одними цифрами', async () => {
    const env = await scenario();
    const decision = (await route(env.channel, '*100#')).json<Preview>();

    expect(decision.reason).toBe('destination_invalid');
    const stored = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select destination from calls where id = ${decision.call_id}`,
      );
      return result.rows[0] as { destination: string };
    });
    // Звёздочки и решётки в поле назначения не нужны: оттуда номер уходит в отчёты
    // и в клиентский контур.
    expect(stored.destination).toBe('100');
  });

  it('база держит исключение узким: ненормализованный номер разрешён только этому отказу', async () => {
    const env = await scenario();
    const invalid = (await route(env.channel, '112')).json<Preview>();

    // Подменить причину, оставив короткий номер, не даст сама база: исключение
    // из формата назначения названо в ограничении поимённо (ADR-0042).
    await expect(
      withDatabase(async (execute) => {
        await execute(
          sql`update calls set failure_reason = 'operator_unconfirmed' where id = ${invalid.call_id}`,
        );
      }),
    ).rejects.toThrow();
  });

  it('чёрный список короткий номер не ловит — и не должен', async () => {
    // Правило чёрного списка это префикс одиннадцатизначного номера длиной не меньше
    // четырёх цифр (ADR-0024). `112` таким префиксом не является ни при какой записи,
    // поэтому диагноз обязан приходить раньше — от разбора номера.
    const env = await scenario();
    expect((await route(env.channel, '112')).json<Preview>().reason).not.toBe(
      'destination_blocked',
    );
  });

  it('отключённый канал не маршрутизируется', async () => {
    const env = await scenario();
    await post(`/channels/${env.channel}/status`, { status: 'suspended' });

    expect((await route(env.channel, env.destination)).json<Preview>().reason).toBe(
      'channel_unknown',
    );
  });
});
