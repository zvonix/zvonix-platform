/**
 * Порядок перебора партнёров задаёт клиент, а не цена (ADR-0014, ADR-0021).
 *
 * Проверяется на реальной базе, потому что весь порядок собирается одним запросом
 * с сортировкой и присоединением приоритетов: подставным репозиторием проверялось бы
 * не то, в каком порядке кандидаты придут из PostgreSQL, а то, как я его себе представляю.
 *
 * Отдельно проверяется инвариант анонимности: наружу уходит только псевдоним. Возврат
 * идентификатора партнёра в клиентский контур ADR-0014 называет дефектом уровня
 * инварианта, а не недосмотром.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
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
  return `79${String(300000000 + msisdnCounter).slice(0, 9)}`;
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

interface Partner {
  readonly id: string;
  readonly aliasId: string;
  readonly displayName: string;
  readonly simId: string;
}

/** Подтверждённый партнёр со шлюзом, портом и активной SIM нужного оператора. */
async function createPartner(operatorId: string, concurrency: number): Promise<Partner> {
  const displayName = unique('Партнёр');
  const partner = (
    await post('/partners', {
      ownerUserId: await createUser('partner'),
      name: 'Иванов Иван',
      displayName,
    })
  ).json<{ partner: { id: string } }>().partner.id;

  await withDatabase(async (execute) => {
    await execute(sql`update partners set status = 'verified' where id = ${partner}`);
  });

  const gateway = (
    await post('/gateways', { partnerId: partner, name: unique('Шлюз'), type: 'goip' })
  ).json<{ gateway: { id: string } }>().gateway.id;
  await post(`/gateways/${gateway}/status`, { status: 'active' });

  const port = (await post(`/gateways/${gateway}/ports`, { portNumber: 1 })).json<{
    port: { id: string };
  }>().port.id;

  const sim = (
    await post('/sim-cards', { partnerId: partner, operatorId, msisdn: nextMsisdn() })
  ).json<{ sim: { id: string } }>().sim.id;
  await post(`/sim-cards/${sim}/status`, { status: 'active' });
  // Больше одного вызова на SIM: иначе первый же занимает её, и чередование
  // равных приоритетов проверить нечем — второй вызов ушёл бы к соседу вынужденно.
  await post(`/sim-cards/${sim}/concurrency`, { maxConcurrentCalls: concurrency });
  await post(`/gateway-ports/${port}/sim`, { simCardId: sim });

  await post('/partner-rates', {
    partnerId: partner,
    operatorId,
    pricePerMinute: '1',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });

  const aliases = (await get('/partner-aliases')).json<{
    partners: { alias_id: string; display_name: string }[];
  }>().partners;
  const alias = aliases.find((row) => row.display_name === displayName);
  if (alias === undefined) throw new Error('Псевдоним партнёра не найден');

  return { id: partner, aliasId: alias.alias_id, displayName, simId: sim };
}

/** Клиент с активным каналом, деньгами и разрешённым номером назначения. */
async function createChannel(
  operatorId: string,
): Promise<{ channel: string; destination: string }> {
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
      values (gen_random_uuid()::text::uuid, ${destination}, ${operatorId}, 'manual', now(), now() + interval '30 days')
    `);
  });

  return { channel, destination };
}

interface Preview {
  outcome: string;
  candidates: { sim_card_id: string }[];
}

/** Маршрут с теми же побочными действиями, что и настоящий: вызов и резерв создаются. */
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

/** Кому ушёл вызов: SIM однозначно принадлежит партнёру. */
function chosenSim(preview: Preview): string {
  expect(preview.outcome).toBe('routed');
  const first = preview.candidates[0];
  if (first === undefined) throw new Error('Кандидатов нет');
  return first.sim_card_id;
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

  nodeId = (await post('/nodes', { name: unique('Узел') })).json<{ node: { id: string } }>().node
    .id;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('порядок перебора', () => {
  it('идёт по приоритетам клиента, а не по цене и не по номеру SIM', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;

    const first = await createPartner(operator, 1);
    const second = await createPartner(operator, 1);
    const { channel, destination } = await createChannel(operator);

    // Второй партнёр объявлен первым по порядку — вызов обязан уйти к нему,
    // хотя цена у обоих одинаковая, а по номеру SIM порядок мог быть любым.
    await put(`/channels/${channel}/partner-priorities`, {
      priorities: [
        { aliasId: second.aliasId, priority: 1 },
        { aliasId: first.aliasId, priority: 2 },
      ],
    });

    expect(chosenSim(await route(channel, destination))).toBe(second.simId);
  }, 120_000);

  it('не использует партнёра, которого нет в списке', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;

    const chosen = await createPartner(operator, 1);
    const excluded = await createPartner(operator, 1);
    const { channel, destination } = await createChannel(operator);

    // Список закрытый: отсутствие в нём и есть «этого партнёра я не хочу».
    await put(`/channels/${channel}/partner-priorities`, {
      priorities: [{ aliasId: chosen.aliasId, priority: 1 }],
    });

    const preview = await route(channel, destination);
    expect(chosenSim(preview)).toBe(chosen.simId);
    expect(preview.candidates.map((candidate) => candidate.sim_card_id)).not.toContain(
      excluded.simId,
    );
  }, 120_000);

  it('без списка перебирает всех: новый канал звонит, а не молчит', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;

    const only = await createPartner(operator, 1);
    const { channel, destination } = await createChannel(operator);

    const preview = await route(channel, destination);
    expect(chosenSim(preview)).toBe(only.simId);
  }, 120_000);

  it('пустой список снимает ограничение', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;

    const chosen = await createPartner(operator, 2);
    const excluded = await createPartner(operator, 2);
    const { channel, destination } = await createChannel(operator);

    await put(`/channels/${channel}/partner-priorities`, {
      priorities: [{ aliasId: chosen.aliasId, priority: 1 }],
    });
    expect(
      (await route(channel, destination)).candidates.map((row) => row.sim_card_id),
    ).not.toContain(excluded.simId);

    await put(`/channels/${channel}/partner-priorities`, { priorities: [] });

    expect((await route(channel, destination)).candidates.map((row) => row.sim_card_id)).toContain(
      excluded.simId,
    );
  }, 120_000);
});

describe('равные приоритеты', () => {
  it('чередуются: следующим идёт тот, кто дольше всех не получал вызова', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;

    // Четыре одновременных вызова на SIM: иначе занятость подменила бы собой очередь,
    // и проверялась бы не ротация, а нехватка места.
    const one = await createPartner(operator, 4);
    const other = await createPartner(operator, 4);
    const { channel, destination } = await createChannel(operator);

    await put(`/channels/${channel}/partner-priorities`, {
      priorities: [
        { aliasId: one.aliasId, priority: 1 },
        { aliasId: other.aliasId, priority: 1 },
      ],
    });

    const chosen: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      chosen.push(chosenSim(await route(channel, destination)));
    }

    // Строгое чередование, а не «примерно поровну»: на малых объёмах это и есть
    // разница между ротацией и случайностью (ADR-0021).
    expect(chosen[0]).not.toBe(chosen[1]);
    expect(chosen[1]).not.toBe(chosen[2]);
    expect(chosen[2]).not.toBe(chosen[3]);
    expect(new Set(chosen).size).toBe(2);
  }, 180_000);
});

describe('анонимность партнёра', () => {
  it('в ответе только псевдоним: ни идентификатора партнёра, ни имени', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;

    const partner = await createPartner(operator, 1);
    const { channel } = await createChannel(operator);

    const response = await put(`/channels/${channel}/partner-priorities`, {
      priorities: [{ aliasId: partner.aliasId, priority: 1 }],
    });
    expect(response.statusCode).toBe(200);

    const body = response.body;
    expect(body).toContain(partner.displayName);
    // Возврат идентификатора партнёра в клиентский контур — дефект уровня инварианта.
    expect(body).not.toContain(partner.id);
    expect(body).not.toContain('Иванов Иван');

    const listed = await get(`/channels/${channel}/partner-priorities`);
    expect(listed.body).not.toContain(partner.id);
    expect(listed.json<{ priorities: { display_name: string }[] }>().priorities[0]).toMatchObject({
      display_name: partner.displayName,
      priority: 1,
    });
  }, 120_000);

  it('отвергает неизвестный псевдоним как «не найдено», а не как ошибку разбора', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;
    const { channel } = await createChannel(operator);

    const response = await put(`/channels/${channel}/partner-priorities`, {
      priorities: [{ aliasId: '01a00000-0000-7000-8000-000000000000', priority: 1 }],
    });
    expect(response.statusCode).toBe(404);
  }, 120_000);

  it('отвергает одного и того же партнёра дважды', async () => {
    const operator = (await post('/operators', { name: unique('Оператор') })).json<{
      operator: { id: string };
    }>().operator.id;
    const partner = await createPartner(operator, 1);
    const { channel } = await createChannel(operator);

    const response = await put(`/channels/${channel}/partner-priorities`, {
      priorities: [
        { aliasId: partner.aliasId, priority: 1 },
        { aliasId: partner.aliasId, priority: 2 },
      ],
    });
    expect(response.statusCode).toBe(400);
  }, 120_000);
});
