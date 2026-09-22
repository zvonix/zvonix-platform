/**
 * Качество терминации и порог отключения (ADR-0027).
 *
 * Главное, что проверяется: **за что отключают, а за что нет**. Абонент не ответил,
 * занято, вызывающий сбросил — это поведение людей, и отключать за него SIM партнёра
 * значит наказывать его за чужих абонентов. Не хватило денег — это платформа.
 * Отключают только за отказы сети.
 *
 * Вызовы заводятся прямо в базе: провести два десятка настоящих отказов через
 * маршрутизацию значило бы проверять маршрутизацию, а не порог.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { parseId } from '@zvonix/shared';
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
  return `79${String(700000000 + msisdnCounter).slice(0, 9)}`;
};

async function post(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url, headers: auth(), payload });
}

async function get(url: string) {
  return api().inject({ method: 'GET', url, headers: auth() });
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

interface Environment {
  readonly partner: string;
  readonly gateway: string;
  readonly sim: string;
  readonly channel: string;
  readonly operator: string;
}

async function environment(): Promise<Environment> {
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

  const channel = (
    await post('/channels', { clientId: client, name: unique('Линия'), recordingRequired: false })
  ).json<{ channel: { id: string } }>().channel.id;
  await post(`/channels/${channel}/status`, { status: 'active' });

  return { partner, gateway, sim, channel, operator };
}

/**
 * Записывает вызов задним числом.
 *
 * `failureReason` пустая означает отказ из телефонии: причину заполняет только
 * control plane, когда отказывает сам.
 */
async function recordCall(
  env: Environment,
  status: string,
  options: { reason?: string; minutesAgo?: number; durationSeconds?: number } = {},
): Promise<void> {
  const minutesAgo = options.minutesAgo ?? 1;
  const reason = options.reason ?? null;
  const duration = options.durationSeconds ?? 0;

  await withDatabase(async (execute) => {
    await execute(sql`
      insert into calls
        (id, external_id, channel_id, node_id, destination, operator_id, sim_card_id, gateway_id,
         status, failure_reason, duration_seconds, started_at)
      values (gen_random_uuid()::text::uuid, ${unique('call')}, ${env.channel}::uuid, ${nodeId}::uuid,
              ${nextMsisdn()}, ${env.operator}::uuid, ${env.sim}::uuid, ${env.gateway}::uuid,
              ${status}, ${reason}, ${duration}, now() - (${minutesAgo} * interval '1 minute'))
    `);
  });
}

async function simStatus(id: string): Promise<string> {
  return withDatabase(async (execute) => {
    const result = await execute(sql`select status from sim_cards where id = ${id}`);
    return (result.rows[0] as { status: string }).status;
  });
}

async function gatewayStatus(id: string): Promise<string> {
  return withDatabase(async (execute) => {
    const result = await execute(sql`select status from gateways where id = ${id}`);
    return (result.rows[0] as { status: string }).status;
  });
}

async function gatewaySuspendedBy(id: string): Promise<string | null> {
  return withDatabase(async (execute) => {
    const result = await execute(sql`select suspended_by from gateways where id = ${id}`);
    return (result.rows[0] as { suspended_by: string | null }).suspended_by;
  });
}

/** Проход порога — тот же, что выполняет воркер по расписанию. */
async function sweep(): Promise<number> {
  const { QualityService } = await import('./quality.service.js');
  return api().get(QualityService).suspendOverThreshold(new Date());
}

async function setThreshold(scope: string, failures: number, windowMinutes: number) {
  return api().inject({
    method: 'PUT',
    url: `/failure-thresholds/${scope}`,
    headers: auth(),
    payload: { failures, windowMinutes },
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

describe('за что отключают', () => {
  it('снимает SIM с маршрутизации по отказам сети', async () => {
    const env = await environment();
    await setThreshold('sim', 3, 60);

    for (let attempt = 0; attempt < 3; attempt += 1) await recordCall(env, 'failed');

    expect(await sweep()).toBeGreaterThan(0);
    expect(await simStatus(env.sim)).toBe('throttled');
  }, 120_000);

  it('не отключает за поведение абонентов', async () => {
    // Не ответил, занято, сбросил — это люди, а не неисправность. Отключать за это
    // SIM партнёра значит наказывать его за чужих абонентов.
    const env = await environment();
    await setThreshold('sim', 3, 60);

    for (const status of ['no_answer', 'busy', 'cancelled', 'no_answer', 'busy']) {
      await recordCall(env, status);
    }

    await sweep();
    expect(await simStatus(env.sim)).toBe('active');
  }, 120_000);

  it('не отключает за отказы платформы', async () => {
    // Не хватило денег, нет тарифа — это мы, а не SIM. Причину отказа заполняет
    // только control plane, и по её наличию они и различаются.
    const env = await environment();
    await setThreshold('sim', 3, 60);

    for (const reason of ['insufficient_funds', 'no_tariff', 'node_lost', 'limit_exceeded']) {
      await recordCall(env, 'failed', { reason });
    }

    await sweep();
    expect(await simStatus(env.sim)).toBe('active');
  }, 120_000);

  it('смотрит в скользящее окно, а не в календарное', async () => {
    // Отказы вчерашнего дня к сегодняшней неисправности отношения не имеют.
    const env = await environment();
    await setThreshold('sim', 3, 60);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await recordCall(env, 'failed', { minutesAgo: 180 });
    }

    await sweep();
    expect(await simStatus(env.sim)).toBe('active');
  }, 120_000);

  it('без заданного порога не отключает ничего', async () => {
    const env = await environment();
    await api().inject({ method: 'DELETE', url: '/failure-thresholds/sim', headers: auth() });

    for (let attempt = 0; attempt < 10; attempt += 1) await recordCall(env, 'failed');

    expect(await sweep()).toBe(0);
    expect(await simStatus(env.sim)).toBe('active');
  }, 120_000);

  it('снимает шлюз, когда порог задан для шлюзов', async () => {
    const env = await environment();
    await api().inject({ method: 'DELETE', url: '/failure-thresholds/sim', headers: auth() });
    await setThreshold('gateway', 2, 60);

    await recordCall(env, 'failed');
    await recordCall(env, 'failed');

    expect(await sweep()).toBeGreaterThan(0);
    expect(await gatewayStatus(env.gateway)).toBe('suspended');
    // Источник — порог: такое отключение партнёр не снимает, включает администратор (ADR-0047).
    expect(await gatewaySuspendedBy(env.gateway)).toBe('failure_threshold');
    // SIM не трогается: порог у неё не задан.
    expect(await simStatus(env.sim)).toBe('active');
  }, 120_000);

  it('SIM неисправного шлюза отдельно не отключается', async () => {
    // Иначе администратору пришлось бы включать обратно два объекта вместо одного, хотя
    // виновато железо, а не пластик.
    const env = await environment();
    await setThreshold('gateway', 2, 60);
    await setThreshold('sim', 2, 60);

    await recordCall(env, 'failed');
    await recordCall(env, 'failed');
    await sweep();

    expect(await gatewayStatus(env.gateway)).toBe('suspended');
    expect(await simStatus(env.sim)).toBe('active');
  }, 120_000);

  it('отключённое обратно не включает', async () => {
    // Отключённая SIM вызовов не получает, её окно опустеет само — автоматический
    // возврат превратился бы в мигание (ADR-0027).
    const env = await environment();
    await api().inject({ method: 'DELETE', url: '/failure-thresholds/gateway', headers: auth() });
    await setThreshold('sim', 2, 60);

    await recordCall(env, 'failed');
    await recordCall(env, 'failed');
    await sweep();
    expect(await simStatus(env.sim)).toBe('throttled');

    // Проход по чистому окну ничего не меняет: возвращает человек.
    await withDatabase(async (execute) => {
      await execute(sql`delete from calls where sim_card_id = ${env.sim}::uuid`);
    });
    await sweep();
    expect(await simStatus(env.sim)).toBe('throttled');
  }, 120_000);

  it('записывает отключение в журнал: партнёр спросит «за что»', async () => {
    const env = await environment();
    await setThreshold('sim', 2, 60);
    await recordCall(env, 'failed');
    await recordCall(env, 'failed');
    await sweep();

    const recorded = await withDatabase(async (execute) => {
      const result = await execute(sql`
        select action, actor_user_id from audit_log
         where entity_id = ${env.sim} and action = 'sim.suspended_by_failures'
      `);
      return result.rows[0] as { action: string; actor_user_id: string | null } | undefined;
    });
    expect(recorded?.action).toBe('sim.suspended_by_failures');
    // Инициатора нет: отключил автомат, а не человек.
    expect(recorded?.actor_user_id).toBeNull();
  }, 120_000);
});

describe('автомат не затирает решение человека (ADR-0047)', () => {
  async function telephonyRepository() {
    const { TelephonyRepository } = await import('./telephony.repository.js');
    return api().get(TelephonyRepository);
  }

  it('выключенный партнёром шлюз порог не перезаписывает', async () => {
    const env = await environment();
    await setThreshold('gateway', 2, 60);
    await withDatabase(async (execute) => {
      await execute(
        sql`update gateways set status = 'suspended', suspended_by = 'partner' where id = ${env.gateway}`,
      );
    });
    await recordCall(env, 'failed');
    await recordCall(env, 'failed');
    await sweep();

    // Своё выключение партнёр снимает сам. Стань источником порог — он потерял бы это право.
    expect(await gatewaySuspendedBy(env.gateway)).toBe('partner');
  }, 120_000);

  it('решение, принятое между отбором и записью, не перезаписывается', async () => {
    const env = await environment();
    const repository = await telephonyRepository();

    // Отбор порога видел `active`, а администратор успел запереть шлюз и заблокировать карту.
    await withDatabase(async (execute) => {
      await execute(
        sql`update gateways set status = 'suspended', suspended_by = 'admin' where id = ${env.gateway}`,
      );
      await execute(sql`update sim_cards set status = 'blocked' where id = ${env.sim}`);
    });

    expect(
      await repository.transitionGateway(
        parseId(env.gateway, 'gateway'),
        { status: 'active', suspendedBy: null },
        { status: 'suspended', suspendedBy: 'failure_threshold' },
      ),
    ).toBeUndefined();
    expect(
      await repository.transitionSimStatus(parseId(env.sim, 'simCard'), 'active', 'throttled'),
    ).toBeUndefined();

    expect(await gatewaySuspendedBy(env.gateway)).toBe('admin');
    expect(await simStatus(env.sim)).toBe('blocked');
  }, 120_000);

  it('списание по устаревшему состоянию не вынимает карты из портов', async () => {
    const env = await environment();
    const repository = await telephonyRepository();

    // Шлюз включён, а списание пришло с представлением «выключен партнёром»: кто-то успел раньше.
    const result = await repository.retireGatewayFreeingPorts(parseId(env.gateway, 'gateway'), {
      status: 'suspended',
      suspendedBy: 'partner',
    });
    expect(result).toBeUndefined();
    expect(await gatewayStatus(env.gateway)).toBe('active');

    // Порядок «сначала состояние, потом порты»: в обратном карта была бы уже вынута,
    // а шлюз так и остался бы работать без неё.
    const inPorts = await withDatabase(async (execute) => {
      const rows = await execute(
        sql`select sim_card_id from gateway_ports where gateway_id = ${env.gateway}`,
      );
      return rows.rows.map((row) => (row as { sim_card_id: string | null }).sim_card_id);
    });
    expect(inPorts).toEqual([env.sim]);
  }, 120_000);

  it('база не принимает отключение без источника и источник без отключения', async () => {
    const env = await environment();

    await expect(
      withDatabase(async (execute) => {
        await execute(sql`update gateways set status = 'suspended' where id = ${env.gateway}`);
      }),
    ).rejects.toThrow();
    await expect(
      withDatabase(async (execute) => {
        await execute(sql`update gateways set suspended_by = 'admin' where id = ${env.gateway}`);
      }),
    ).rejects.toThrow();
  }, 120_000);
});

describe('качество для человека', () => {
  it('считает ASR и ACD по вызовам', async () => {
    const env = await environment();
    await api().inject({ method: 'DELETE', url: '/failure-thresholds/sim', headers: auth() });

    await recordCall(env, 'completed', { durationSeconds: 60 });
    await recordCall(env, 'completed', { durationSeconds: 120 });
    await recordCall(env, 'no_answer');
    await recordCall(env, 'failed');

    const rows = (await get(`/quality/sims?partnerId=${env.partner}&windowMinutes=60`)).json<{
      sims: { subject_id: string; asr_basis_points: number; acd_seconds: number }[];
    }>().sims;
    const found = rows.find((row) => row.subject_id === env.sim);

    // Два отвеченных из четырёх попыток — половина; средняя длительность 90 секунд.
    expect(found).toMatchObject({
      attempts: 4,
      answered: 2,
      network_failures: 1,
      asr_basis_points: 5000,
      acd_seconds: 90,
    });
  }, 120_000);

  it('шлюзы считаются отдельно от SIM', async () => {
    const env = await environment();
    await recordCall(env, 'completed', { durationSeconds: 30 });

    const rows = (await get(`/quality/gateways?partnerId=${env.partner}`)).json<{
      gateways: { subject_id: string; answered: number }[];
    }>().gateways;
    expect(rows.find((row) => row.subject_id === env.gateway)?.answered).toBe(1);
  }, 120_000);
});

describe('ведение порогов', () => {
  it('порог на область один и заменяется целиком', async () => {
    expect((await setThreshold('sim', 5, 30)).statusCode).toBe(200);
    expect((await setThreshold('sim', 7, 15)).statusCode).toBe(200);

    const listed = (await get('/failure-thresholds')).json<{
      thresholds: { scope: string; failures: number; window_minutes: number }[];
    }>().thresholds;
    const sim = listed.filter((row) => row.scope === 'sim');
    expect(sim).toHaveLength(1);
    expect(sim[0]).toMatchObject({ failures: 7, window_minutes: 15 });
  }, 120_000);

  it('отвергает порог в один отказ', async () => {
    // Один отказ сети случается и на исправной SIM: абонент вне зоны, сеть отвергла.
    expect((await setThreshold('sim', 1, 60)).statusCode).toBe(400);
  }, 120_000);

  it('отвергает неизвестную область', async () => {
    // Канал автоматически не отключается: это решение с последствиями для выручки.
    expect((await setThreshold('channel', 5, 60)).statusCode).toBe(400);
  }, 120_000);

  it('разбор маршрута сообщает, сколько занял', async () => {
    // Единственный способ узнать длительность решения, не заводя нагрузочный стенд.
    const env = await environment();
    const response = await post('/routing/preview', {
      callId: unique('call'),
      channelId: env.channel,
      nodeId,
      destination: nextMsisdn(),
    });
    expect(response.json<{ decision_ms: number }>().decision_ms).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
