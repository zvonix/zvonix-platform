/**
 * Прогрев и рекомендованная работа номера (ADR-0105), пауза, разные абоненты, перезвон и предел абоненту (ADR-0106).
 *
 * На реальной базе: попытки считаются по таблице вызовов, и предел пересчитывается в той же транзакции, что
 * занимает номер. Фон остальных наборов — без предела (`resetDatabase`), здесь он включается настройками.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientFailureReasonOf } from '@zvonix/shared';
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
  readonly gatewayId: string;
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

  return { id: partner, simId: sim, gatewayId: gateway };
}

/** Ещё одна SIM того же партнёра в том же шлюзе: та же цена, тот же партнёр — одна группа перебора. */
async function addSim(partner: Partner, operatorId: string, portNumber: number): Promise<string> {
  const port = (await post(`/gateways/${partner.gatewayId}/ports`, { portNumber })).json<{
    port: { id: string };
  }>().port.id;
  const sim = (
    await post('/sim-cards', { partnerId: partner.id, operatorId, msisdn: nextMsisdn() })
  ).json<{ sim: { id: string } }>().sim.id;
  await post(`/sim-cards/${sim}/status`, { status: 'active' });
  await post(`/sim-cards/${sim}/concurrency`, { maxConcurrentCalls: 4 });
  await post(`/gateway-ports/${port}/sim`, { simCardId: sim });
  return sim;
}

/** Ещё один абонент того же оператора. */
async function subscriber(operator: string): Promise<string> {
  const destination = nextMsisdn();
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into number_resolutions (id, msisdn, operator_id, source, resolved_at, expires_at)
      values (gen_random_uuid()::text::uuid, ${destination}, ${operator}, 'manual', now(), now() + interval '30 days')
    `);
  });
  return destination;
}

/** Вызов закончился `secondsAgo` секунд назад: так проверяется пауза после конца. */
async function endCall(callId: string, secondsAgo = 0) {
  await withDatabase(async (execute) => {
    await execute(sql`
      update calls set status = 'completed', answered_at = started_at,
                       ended_at = now() - make_interval(secs => ${secondsAgo}), duration_seconds = 0
       where external_id = ${callId}
    `);
  });
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

/** Всё про номер выключено — каждый тест включает только своё. */
const PACE_OFF = {
  'calls.warmup_enabled': false,
  'calls.recommended_per_hour': 0,
  'calls.recommended_per_day': 0,
  'calls.pause_seconds': 0,
  'calls.warmup_pause_seconds': 0,
  'calls.distinct_per_hour': 0,
  'calls.distinct_per_day': 0,
  'calls.recipient_per_hour': 0,
  'calls.recipient_per_day': 0,
  'calls.sleep_hours': 0,
  'calls.poor_answer_percent': 0,
};

async function settings(values: Record<string, unknown>) {
  const response = await api().inject({
    method: 'PUT',
    url: '/settings',
    headers: auth(),
    payload: { settings: { ...PACE_OFF, ...values } },
  });
  expect(response.statusCode).toBe(200);
}

interface SimPace {
  warmup_day: number | null;
  per_hour: number | null;
  per_day: number | null;
  used_hour: number;
  used_day: number;
  distinct_per_hour?: number | null;
  distinct_used_hour?: number;
  resting_until?: string | null;
  poor?: boolean;
}

async function paceOf(partnerId: string, simId: string): Promise<SimPace | undefined> {
  const response = await get(`/sim-cards?partnerId=${partnerId}`);
  expect(response.statusCode).toBe(200);
  return response
    .json<{ sim_cards: { id: string; pace?: SimPace }[] }>()
    .sim_cards.find((sim) => sim.id === simId)?.pace;
}

async function warmupStartedAt(simId: string): Promise<unknown> {
  return withDatabase(async (execute) => {
    const result = await execute(sql`select warmup_started_at from sim_cards where id = ${simId}`);
    return (result.rows[0] as { warmup_started_at: unknown } | undefined)?.warmup_started_at;
  });
}

/** Попытки «в прошлом»: номер звонил, но давно — проверка молчания и прогретости. */
async function pastCall(channel: string, simId: string, startedAt: string) {
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into calls (id, external_id, channel_id, node_id, operator_id, destination, sim_card_id, gateway_id,
                         status, started_at)
      select gen_random_uuid(), ${unique('old')}, ${channel}, ${nodeId}, s.operator_id, '79000000000', s.id,
             p.gateway_id, 'completed', ${startedAt}::timestamptz
        from sim_cards s join gateway_ports p on p.sim_card_id = s.id
       where s.id = ${simId}
    `);
  });
}

describe('прогрев и рекомендованная работа номера (ADR-0105)', () => {
  it('новый номер: два вызова в час, третий уходит на соседа, отсчёт прогрева ставит первый вызов', async () => {
    await settings({
      'calls.warmup_enabled': true,
      'calls.recommended_per_hour': 20,
      'calls.recommended_per_day': 150,
    });
    const { operator, channel, destination } = await scenario();
    const fresh = await createPartner(operator);

    expect(await warmupStartedAt(fresh.simId)).toBeNull();
    const first = await route(channel, destination);
    expect(first.outcome).toBe('routed');
    expect(first.candidates[0]?.sim_card_id).toBe(fresh.simId);
    expect(await warmupStartedAt(fresh.simId)).not.toBeNull();
    expect((await route(channel, destination)).outcome).toBe('routed');

    // Единственный номер исчерпал час — отказ «номера исчерпаны», а не «нет SIM» и не лимит клиента (ADR-0107).
    const third = await route(channel, destination);
    expect(third.outcome).toBe('rejected');
    expect(third.reason).toBe('numbers_exhausted');

    const pace = await paceOf(fresh.id, fresh.simId);
    expect(pace).toMatchObject({
      warmup_day: 1,
      per_hour: 2,
      per_day: 10,
      used_hour: 2,
      used_day: 2,
    });

    // Появился сосед — вызов уходит к нему, а не отказывается.
    const neighbour = await createPartner(operator);
    const fourth = await route(channel, destination);
    expect(fourth.outcome).toBe('routed');
    expect(fourth.candidates[0]?.sim_card_id).toBe(neighbour.simId);
  });

  it('звонивший номер без отметки прогрет: действует рекомендованное «в час»', async () => {
    await settings({
      'calls.warmup_enabled': true,
      'calls.recommended_per_hour': 3,
      'calls.recommended_per_day': 150,
    });
    const { operator, channel, destination } = await scenario();
    const warmed = await createPartner(operator);
    await pastCall(channel, warmed.simId, new Date(Date.now() - 2 * 86_400_000).toISOString());

    for (let index = 0; index < 3; index += 1) {
      expect((await route(channel, destination)).outcome).toBe('routed');
    }
    expect((await route(channel, destination)).reason).toBe('numbers_exhausted');
    expect(await paceOf(warmed.id, warmed.simId)).toMatchObject({
      warmup_day: null,
      per_hour: 3,
      used_hour: 3,
    });
    expect(await warmupStartedAt(warmed.simId)).toBeNull();
  });

  it('молчавший 14 суток номер прогревается заново', async () => {
    await settings({
      'calls.warmup_enabled': true,
      'calls.recommended_per_hour': 20,
      'calls.recommended_per_day': 150,
    });
    const { operator, channel, destination } = await scenario();
    const idle = await createPartner(operator);
    await pastCall(channel, idle.simId, new Date(Date.now() - 20 * 86_400_000).toISOString());

    expect(await paceOf(idle.id, idle.simId)).toMatchObject({ warmup_day: 1, per_hour: 2 });
    expect((await route(channel, destination)).outcome).toBe('routed');
    expect(await warmupStartedAt(idle.simId)).not.toBeNull();
  });

  it('выключено и нули — номер без предела', async () => {
    await settings({
      'calls.warmup_enabled': false,
      'calls.recommended_per_hour': 0,
      'calls.recommended_per_day': 0,
    });
    const { operator, channel, destination } = await scenario();
    const free = await createPartner(operator);
    for (let index = 0; index < 4; index += 1) {
      expect((await route(channel, destination)).outcome).toBe('routed');
    }
    expect(await paceOf(free.id, free.simId)).toEqual({
      warmup_day: null,
      per_hour: null,
      per_day: null,
      used_hour: 4,
      used_day: 4,
      distinct_per_hour: null,
      distinct_per_day: null,
      distinct_used_hour: 1,
      distinct_used_day: 1,
      resting_until: null,
      asleep_until: null,
      poor: false,
    });
  });
});

describe('ровный темп номера и абоненты (ADR-0106)', () => {
  it('пауза после конца: вызов уходит на соседа, отдыхают все — отказ, пауза прошла — номер звонит', async () => {
    await settings({ 'calls.pause_seconds': 30 });
    const { operator, channel, destination } = await scenario();
    const one = await createPartner(operator);
    const two = await createPartner(operator);

    const first = await route(channel, destination);
    expect(first.outcome).toBe('routed');
    const firstSim = first.candidates[0]?.sim_card_id ?? '';
    expect([one.simId, two.simId]).toContain(firstSim);
    await endCall(first.callId);

    const second = await route(channel, destination);
    expect(second.outcome).toBe('routed');
    expect(second.candidates.map((candidate) => candidate.sim_card_id)).not.toContain(firstSim);
    await endCall(second.callId);

    const third = await route(channel, destination);
    expect(third.outcome).toBe('rejected');
    expect(third.reason).toBe('numbers_exhausted');
    const resting = await paceOf(firstSim === one.simId ? one.id : two.id, firstSim);
    expect(resting?.resting_until).not.toBeNull();

    // Пауза с самым большим разбросом — 45 с: через 50 с номер свободен.
    await endCall(first.callId, 50);
    const fourth = await route(channel, destination);
    expect(fourth.outcome).toBe('routed');
    expect(fourth.candidates[0]?.sim_card_id).toBe(firstSim);
  });

  it('разные абоненты: новый сверх предела — отказ, знакомому номер звонит', async () => {
    await settings({ 'calls.distinct_per_hour': 2 });
    const { operator, channel, destination } = await scenario();
    const only = await createPartner(operator);
    const second = await subscriber(operator);
    const third = await subscriber(operator);

    expect((await route(channel, destination)).outcome).toBe('routed');
    expect((await route(channel, second)).outcome).toBe('routed');
    expect((await route(channel, third)).reason).toBe('numbers_exhausted');
    // Перезвон знакомому нового абонента не добавляет.
    expect((await route(channel, destination)).outcome).toBe('routed');
    expect(await paceOf(only.id, only.simId)).toMatchObject({
      distinct_per_hour: 2,
      distinct_used_hour: 2,
      used_hour: 3,
    });
  });

  it('перезвон — с того же номера, хотя по очереди был бы другой', async () => {
    await settings({});
    const { operator, channel, destination } = await scenario();
    const partner = await createPartner(operator);
    const otherSim = await addSim(partner, operator, 2);

    const first = await route(channel, destination);
    const used = first.candidates[0]?.sim_card_id;
    expect([partner.simId, otherSim]).toContain(used);
    // По давности следующим шёл бы другой номер — перезвон возвращает того, кто уже звонил.
    const again = await route(channel, destination);
    expect(again.candidates[0]?.sim_card_id).toBe(used);
    // Новому абоненту — обычный порядок: давность отдаёт его другому номеру.
    const fresh = await route(channel, await subscriber(operator));
    expect(fresh.candidates[0]?.sim_card_id).not.toBe(used);
  });

  it('предел звонков клиента одному абоненту: сверх — recipient_limit, другому можно', async () => {
    await settings({ 'calls.recipient_per_hour': 2, 'calls.recipient_per_day': 12 });
    const { operator, channel, destination } = await scenario();
    await createPartner(operator);

    expect((await route(channel, destination)).outcome).toBe('routed');
    expect((await route(channel, destination)).outcome).toBe('routed');
    const third = await route(channel, destination);
    expect(third.outcome).toBe('rejected');
    expect(third.reason).toBe('recipient_limit');
    expect(third.sip_response).toBe('503 Service Unavailable');
    expect((await route(channel, await subscriber(operator))).outcome).toBe('routed');
  });

  it('отказ площадки после занятия номера попыткой не считается', async () => {
    await settings({ 'calls.recipient_per_hour': 1, 'calls.distinct_per_hour': 1 });
    const { operator, channel, destination } = await scenario();
    await createPartner(operator);
    const first = await route(channel, destination);
    await withDatabase(async (execute) => {
      await execute(sql`
        update calls set status = 'failed', failure_reason = 'insufficient_funds', ended_at = now()
         where external_id = ${first.callId}
      `);
    });
    expect((await route(channel, destination)).outcome).toBe('routed');
    expect((await route(channel, await subscriber(operator))).reason).toBe('numbers_exhausted');
  });

  it('тревога: у партнёра за час порог снял две SIM', async () => {
    const { QualityService } = await import('../telephony/quality.service.js');
    const { operator } = await scenario();
    const partner = await createPartner(operator);
    const another = await addSim(partner, operator, 2);
    await withDatabase(async (execute) => {
      await execute(sql`
        update sim_cards set status = 'throttled', status_changed_at = now()
         where id in (${partner.simId}, ${another})
      `);
    });
    const bursts = await api()
      .get(QualityService)
      .suspensionBursts(new Date(Date.now() - 3_600_000));
    expect(bursts.find((burst) => burst.partnerId === partner.id)).toMatchObject({
      sims: 2,
      gateways: 0,
    });
  });
});

describe('«плохой» номер, честная причина и отчёт блокировок (ADR-0107)', () => {
  /** Попытки номера два часа назад: `answered` из них — разговор 30 секунд. */
  async function pastAttempts(channel: string, simId: string, total: number, answered: number) {
    await withDatabase(async (execute) => {
      await execute(sql`
        insert into calls (id, external_id, channel_id, node_id, operator_id, destination, sim_card_id, gateway_id,
                           status, started_at, answered_at, ended_at, duration_seconds)
        select gen_random_uuid(), ${unique('past')} || '-' || n, ${channel}, ${nodeId}, s.operator_id, '79000000000',
               s.id, p.gateway_id,
               case when n <= ${answered} then 'completed' else 'no_answer' end,
               now() - interval '2 hours',
               case when n <= ${answered} then now() - interval '2 hours' end,
               now() - interval '2 hours' + interval '30 seconds',
               case when n <= ${answered} then 30 else 0 end
          from sim_cards s join gateway_ports p on p.sim_card_id = s.id, generate_series(1, ${total}) n
         where s.id = ${simId}
      `);
    });
  }

  it('мало настоящих ответов — пределы номера вдвое, ответов достаточно — как обычно', async () => {
    await settings({
      'calls.recommended_per_hour': 40,
      'calls.recommended_per_day': 100,
      'calls.poor_answer_percent': 20,
    });
    const { operator, channel } = await scenario();
    const poor = await createPartner(operator);
    const good = await createPartner(operator);
    await pastAttempts(channel, poor.simId, 20, 2);
    await pastAttempts(channel, good.simId, 20, 10);

    expect(await paceOf(poor.id, poor.simId)).toMatchObject({
      poor: true,
      per_hour: 20,
      per_day: 50,
    });
    expect(await paceOf(good.id, good.simId)).toMatchObject({
      poor: false,
      per_hour: 40,
      per_day: 100,
    });
  });

  it('все номера исчерпаны — numbers_exhausted, клиент видит platform', async () => {
    await settings({ 'calls.recommended_per_hour': 1 });
    const { operator, channel, destination } = await scenario();
    await createPartner(operator);
    expect((await route(channel, destination)).outcome).toBe('routed');
    const refused = await route(channel, destination);
    expect(refused.reason).toBe('numbers_exhausted');
    expect(refused.sip_response).toBe('503 Service Unavailable');
    expect(clientFailureReasonOf('numbers_exhausted')).toBe('platform');
  });

  it('отчёт блокировок: попытки, ответы и снятые SIM по партнёру и оператору', async () => {
    const { operator, channel } = await scenario();
    const partner = await createPartner(operator);
    await pastAttempts(channel, partner.simId, 120, 30);
    await withDatabase(async (execute) => {
      await execute(sql`
        insert into audit_log (id, action, entity_type, entity_id, occurred_at)
        values (gen_random_uuid(), 'sim.suspended_by_failures', 'sim_card', ${partner.simId}, now())
      `);
    });

    const response = await get('/quality/blocks?days=7');
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      days: number;
      partners: { id: string }[];
      operators: { id: string }[];
    }>();
    expect(body.days).toBe(7);
    expect(body.partners.find((row) => row.id === partner.id)).toMatchObject({
      attempts: 120,
      real_answered: 30,
      sims_suspended: 1,
      per_thousand: 8.3,
    });
    expect(body.operators.find((row) => row.id === operator)).toMatchObject({ sims_suspended: 1 });
    expect((await get('/quality/blocks?days=0')).statusCode).toBe(400);
  });
});
