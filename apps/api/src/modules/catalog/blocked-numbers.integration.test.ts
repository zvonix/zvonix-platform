/**
 * Чёрный список номеров (ADR-0024).
 *
 * Проверяется главное свойство: запрет действует **на уровне маршрутизации, до всякой
 * тарификации**. Ни SIM, ни тарифа, ни денег для этого не нужно — вызов отклоняется
 * раньше, чем платформа вообще узнаёт, кто обслуживает номер.
 *
 * Разбор номера на префиксы проверен без базы в `blocked-numbers.test.ts`.
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
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
}

async function post(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url, headers: auth(), payload });
}

async function createUser(role: 'client' | 'support'): Promise<string> {
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

/** Активный канал активного клиента. Ни SIM, ни денег: до них дело не дойдёт. */
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
  return channel;
}

interface Preview {
  outcome: string;
  reason: string | null;
  sip_response: string | null;
  call_id: string | null;
}

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

async function block(prefix: string, note = 'Проверка') {
  return post('/blocked-numbers', { prefix, note });
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

describe('запрет на уровне маршрутизации', () => {
  it('отклоняет вызов на запрещённый диапазон — без SIM, тарифа и денег', async () => {
    const channel = await createChannel();
    expect((await block('7809', 'Премиум-номера: платит партнёр')).statusCode).toBe(201);

    const decision = await route(channel, '78091234567');
    expect(decision.outcome).toBe('rejected');
    expect(decision.reason).toBe('destination_blocked');
    // Звонящему причина не раскрывается: `403` без подробностей.
    expect(decision.sip_response).toBe('403 Forbidden');
    // Отказ записан как вызов: иначе на вопрос «почему у клиента не звонит»
    // отвечать нечем.
    expect(decision.call_id).not.toBeNull();
  }, 120_000);

  it('принимает префикс так, как его пишет человек', async () => {
    // `8-809` — привычная запись междугородного набора. Принять её буквально значило бы
    // завести правило, которое не совпадёт ни с одним номером: номера хранятся как `7809…`.
    const channel = await createChannel();
    const created = await block('8-810', 'Международный набор');
    expect(created.json<{ rule: { prefix: string } }>().rule.prefix).toBe('7810');

    expect((await route(channel, '88101234567')).reason).toBe('destination_blocked');
  }, 120_000);

  it('не задевает номер вне запрета', async () => {
    const channel = await createChannel();
    await block('79991110000', 'Точечный запрет одного номера');

    // Соседний номер проходит запрет и упирается уже в следующую проверку —
    // определение оператора. То есть чёрный список к нему отношения не имеет,
    // и заодно видно, что запрет стоит именно перед определением оператора.
    expect((await route(channel, '79991110001')).reason).toBe('operator_unconfirmed');
  }, 120_000);

  it('снятый запрет перестаёт действовать', async () => {
    const channel = await createChannel();
    const created = await block('7808', 'Ошибочный запрет');
    const id = created.json<{ rule: { id: string } }>().rule.id;
    expect((await route(channel, '78081234567')).reason).toBe('destination_blocked');

    const removed = await api().inject({
      method: 'DELETE',
      url: `/blocked-numbers/${id}`,
      headers: auth(),
    });
    expect(removed.statusCode).toBe(200);

    // Снова упирается в следующую проверку, а не в запрет.
    expect((await route(channel, '78081234567')).reason).toBe('operator_unconfirmed');
  }, 120_000);
});

describe('ведение списка', () => {
  it('не даёт запретить всю страну', async () => {
    // `7` — это вся Россия, `79` — вся мобильная связь. Отказ в обслуживании из-за такой
    // опечатки выглядит для клиента точно так же, как авария платформы.
    expect((await block('7', 'Опечатка')).statusCode).toBe(400);
    expect((await block('79', 'Опечатка')).statusCode).toBe(400);
  }, 120_000);

  it('требует причину', async () => {
    const response = await post('/blocked-numbers', { prefix: '7807', note: '' });
    expect(response.statusCode).toBe(400);
  }, 120_000);

  it('не заводит одно правило дважды', async () => {
    expect((await block('7806', 'Первое')).statusCode).toBe(201);
    expect((await block('7806', 'Второе')).statusCode).toBe(409);
  }, 120_000);

  it('отвечает «не найдено» на снятие несуществующего правила', async () => {
    const response = await api().inject({
      method: 'DELETE',
      url: '/blocked-numbers/01a00000-0000-7000-8000-000000000000',
      headers: auth(),
    });
    expect(response.statusCode).toBe(404);
  }, 120_000);

  it('поддержка читает список, но не меняет его', async () => {
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

    const listed = await api().inject({ method: 'GET', url: '/blocked-numbers', headers });
    expect(listed.statusCode).toBe(200);

    const created = await api().inject({
      method: 'POST',
      url: '/blocked-numbers',
      headers,
      payload: { prefix: '7805', note: 'Поддержка не заводит запреты' },
    });
    expect(created.statusCode).toBe(403);
  }, 120_000);
});
