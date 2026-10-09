/**
 * Распределение сообщений MAX, которое выбирает партнёр ([ADR-0080](../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)):
 * настройки через API, порядок по списку, «один получатель — один аккаунт», тихие часы — на реальной базе.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  withDatabase,
} from '../../testing/harness.js';
import { bearer, fixtures } from './messaging.fixtures.js';
import { MessagesService } from './messages.service.js';
import { simulateAccountState } from './simulated.provider.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const fx = fixtures(api, () => adminToken);

const send = (token: string, to: string) =>
  api().inject({
    method: 'POST',
    url: '/client/messages',
    headers: bearer(token),
    payload: { to, text: 'Привет' },
  });

const settingsBody = (patch: Record<string, unknown> = {}) => ({
  mode: 'equal',
  reservePercent: 0,
  quietFromMinute: null,
  quietToMinute: null,
  timezone: 'Europe/Moscow',
  stickyRecipient: false,
  ...patch,
});

const putSettings = (token: string, patch: Record<string, unknown>) =>
  api().inject({
    method: 'PUT',
    url: '/partner/distribution/messages',
    headers: bearer(token),
    payload: settingsBody(patch),
  });

async function addAccount(partner: { ownerToken: string }, label: string) {
  const made = await api().inject({
    method: 'POST',
    url: '/partner/messenger/accounts',
    headers: bearer(partner.ownerToken),
    payload: { label },
  });
  expect(made.statusCode).toBe(201);
  const id = made.json<{ account: { id: string } }>().account.id;
  const instance = await withDatabase(async (execute) => {
    const result = await execute(
      sql`select provider_instance_id as instance from messenger_accounts where id = ${id}`,
    );
    return (result.rows[0] as { instance: string }).instance;
  });
  await withDatabase(async (execute) => {
    await execute(sql`update messenger_accounts set warmup_enabled = false where id = ${id}`);
  });
  simulateAccountState(instance, 'authorized', '79990004455');
  await api().inject({
    method: 'GET',
    url: `/partner/messenger/accounts/${id}/qr`,
    headers: bearer(partner.ownerToken),
  });
  return { id, instance };
}

const rank = (token: string, id: string, body: Record<string, unknown>) =>
  api().inject({
    method: 'PATCH',
    url: `/partner/messenger/accounts/${id}/distribution`,
    headers: bearer(token),
    payload: body,
  });

const accountOf = async (messageId: string): Promise<string> =>
  withDatabase(async (execute) => {
    const result = await execute(
      sql`select account_id as id from messages where id = ${messageId}`,
    );
    return (result.rows[0] as { id: string }).id;
  });

const messageId = (response: Awaited<ReturnType<typeof send>>): string =>
  response.json<{ message: { id: string } }>().message.id;

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  adminToken = (await fx.user('admin')).token;
  expect((await fx.put(adminToken, { 'messaging.enabled': true })).statusCode).toBe(200);
});

/** Каждая проверка начинается без чужих аккаунтов и сообщений: они перехватывали бы выбор по цене. */
beforeEach(async () => {
  await withDatabase(async (execute) => {
    await execute(sql`delete from messages`);
    await execute(sql`delete from partner_distributions`);
    await execute(sql`delete from messenger_accounts`);
  });
  await fx.put(adminToken, { 'messages.pace_seconds': 0 });
});

afterAll(async () => {
  await app?.close();
});

describe('настройка распределения (ADR-0080)', () => {
  it('по умолчанию «поровну»; настройка сохраняется, неверное отвергается, чужой кабинет закрыт', async () => {
    const partner = await fx.partnerWithAccount('0.45');
    const initial = await api().inject({
      method: 'GET',
      url: '/partner/distribution/messages',
      headers: bearer(partner.ownerToken),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json<{ settings: { mode: string } }>().settings.mode).toBe('equal');

    const saved = await putSettings(partner.ownerToken, {
      mode: 'weighted',
      reservePercent: 10,
      quietFromMinute: 23 * 60,
      quietToMinute: 7 * 60,
      stickyRecipient: true,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ settings: Record<string, unknown> }>().settings).toMatchObject({
      mode: 'weighted',
      reserve_percent: 10,
      quiet_from_minute: 1380,
      quiet_to_minute: 420,
      sticky_recipient: true,
    });

    expect((await putSettings(partner.ownerToken, { mode: 'случайно' })).statusCode).toBe(400);
    expect((await putSettings(partner.ownerToken, { reservePercent: 80 })).statusCode).toBe(400);
    expect((await putSettings(partner.ownerToken, { quietFromMinute: 60 })).statusCode).toBe(400);
    expect(
      (await putSettings(partner.ownerToken, { quietFromMinute: 60, quietToMinute: 60 }))
        .statusCode,
    ).toBe(400);
    expect((await putSettings(partner.ownerToken, { timezone: 'Mars/Base' })).statusCode).toBe(400);

    const client = await fx.clientWithMoney('5');
    expect((await putSettings(client.token, {})).statusCode).toBe(403);
    expect(
      (
        await api().inject({
          method: 'GET',
          url: '/partner/distribution/messages',
          headers: bearer(adminToken),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('вес и приоритет: границы, чужой аккаунт недоступен', async () => {
    const partner = await fx.partnerWithAccount('0.45');
    const other = await fx.partnerWithAccount('0.45');
    expect(
      (await rank(partner.ownerToken, partner.accountId, { weight: 3, priority: 2 })).statusCode,
    ).toBe(200);
    expect((await rank(partner.ownerToken, partner.accountId, { weight: 0 })).statusCode).toBe(400);
    expect((await rank(partner.ownerToken, partner.accountId, {})).statusCode).toBe(400);
    expect((await rank(partner.ownerToken, other.accountId, { weight: 2 })).statusCode).toBe(404);
  });
});

describe('выбор аккаунта по режиму партнёра', () => {
  it('«по порядку»: сообщения идут на первый аккаунт, пока он не упрётся в предел, потом на второй', async () => {
    const partner = await fx.partnerWithAccount('0.45', { limitPerDay: 2 });
    const second = await addAccount(partner, 'Запасной');
    await rank(partner.ownerToken, partner.accountId, { priority: 1 });
    await rank(partner.ownerToken, second.id, { priority: 2 });
    await putSettings(partner.ownerToken, { mode: 'sequential' });
    const client = await fx.clientWithMoney('10');

    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1)
      ids.push(messageId(await send(client.token, `7900555010${String(n)}`)));
    const accounts = await Promise.all(ids.map(accountOf));
    expect(accounts).toEqual([partner.accountId, partner.accountId, second.id]);
  });

  it('«по весам» 3 : 1: на второй аккаунт уходит четверть сообщений', async () => {
    const partner = await fx.partnerWithAccount('0.45');
    const second = await addAccount(partner, 'Лёгкий');
    await rank(partner.ownerToken, partner.accountId, { weight: 3 });
    await putSettings(partner.ownerToken, { mode: 'weighted' });
    const client = await fx.clientWithMoney('10');

    const ids: string[] = [];
    for (let n = 0; n < 8; n += 1)
      ids.push(messageId(await send(client.token, `7900555020${String(n)}`)));
    const accounts = await Promise.all(ids.map(accountOf));
    expect(accounts.filter((id) => id === partner.accountId)).toHaveLength(6);
    expect(accounts.filter((id) => id === second.id)).toHaveLength(2);
  });

  it('«один получатель — один аккаунт»: повторное сообщение идёт с того же аккаунта', async () => {
    const partner = await fx.partnerWithAccount('0.45');
    await addAccount(partner, 'Второй');
    await addAccount(partner, 'Третий');
    await putSettings(partner.ownerToken, { stickyRecipient: true });
    const client = await fx.clientWithMoney('10');

    const first = await accountOf(messageId(await send(client.token, '79005550301')));
    // Другой номер разводит очередь на другие аккаунты, а прежнему получателю возвращается тот же.
    await send(client.token, '79005550302');
    await send(client.token, '79005550303');
    const again = await accountOf(messageId(await send(client.token, '79005550301')));
    expect(again).toBe(first);

    // Без настройки то же самое сообщение ушло бы на самый свободный аккаунт.
    await putSettings(partner.ownerToken, { stickyRecipient: false });
    const free = await accountOf(messageId(await send(client.token, '79005550301')));
    expect(free).not.toBe(first);
  });

  it('тихие часы: аккаунт в них не получает новых сообщений, а ждущие переносятся на другой', async () => {
    const partner = await fx.partnerWithAccount('0.45');
    const quiet = new Date();
    // Весь суточный круг тихий для первого партнёра, кроме одной минуты: окно «сейчас» гарантированно внутри.
    const nowMinute = quiet.getUTCHours() * 60 + quiet.getUTCMinutes();
    await putSettings(partner.ownerToken, {
      timezone: 'UTC',
      quietFromMinute: (nowMinute + 1380) % 1440,
      quietToMinute: (nowMinute + 120) % 1440,
    });
    const client = await fx.clientWithMoney('10');
    const id = messageId(await send(client.token, '79005550401'));

    await api().get(MessagesService).dispatchDue(new Date());
    const row = await withDatabase(async (execute) => {
      const result = await execute(sql`select status from messages where id = ${id}`);
      return (result.rows[0] as { status: string }).status;
    });
    // Единственный аккаунт спит: сообщение ждёт, а не уходит и не отклоняется.
    expect(row).toBe('queued');
  });
});
