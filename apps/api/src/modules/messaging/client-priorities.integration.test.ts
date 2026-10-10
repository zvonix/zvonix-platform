/**
 * Приоритеты партнёров у клиента ([ADR-0081](../../../../../docs/adr/0081-prioritety-partnyorov-u-klienta.md)) для сообщений
 * MAX на реальной базе: цифры, переход к следующей цифре, «не использовать», партнёры вне списка, защита кабинета.
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

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const fx = fixtures(api, () => adminToken);

let number = 0;
const send = (token: string) => {
  number += 1;
  return api().inject({
    method: 'POST',
    url: '/client/messages',
    headers: bearer(token),
    payload: { to: `7900666${String(number).padStart(4, '0')}`, text: 'Привет' },
  });
};

const aliasOf = async (partnerId: string): Promise<string> =>
  withDatabase(async (execute) => {
    const result = await execute(
      sql`select id from partner_aliases where partner_id = ${partnerId}`,
    );
    return (result.rows[0] as { id: string }).id;
  });

const accountOf = async (response: Awaited<ReturnType<typeof send>>): Promise<string> => {
  expect(response.statusCode).toBe(201);
  const id = response.json<{ message: { id: string } }>().message.id;
  return withDatabase(async (execute) => {
    const result = await execute(sql`select account_id as id from messages where id = ${id}`);
    return (result.rows[0] as { id: string }).id;
  });
};

const setList = (
  token: string,
  entries: { aliasId: string; offer?: string; priority: number | null }[],
  product = 'messages',
) =>
  api().inject({
    method: 'PUT',
    url: `/client/partner-priorities?product=${product}`,
    headers: bearer(token),
    payload: {
      priorities: entries.map((entry) => ({ offer: 'message', ...entry })),
    },
  });

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  adminToken = (await fx.user('admin')).token;
  expect((await fx.put(adminToken, { 'messaging.enabled': true })).statusCode).toBe(200);
});

/** Каждая проверка начинается без чужих аккаунтов, сообщений и списков: они перехватывали бы выбор. */
beforeEach(async () => {
  await withDatabase(async (execute) => {
    await execute(sql`delete from messages`);
    await execute(sql`delete from client_partner_priorities`);
    await execute(sql`delete from messenger_accounts`);
  });
  await fx.put(adminToken, { 'messages.pace_seconds': 0 });
});

afterAll(async () => {
  await app?.close();
});

describe('список приоритетов клиента (ADR-0081)', () => {
  it('сохраняется целиком, читается псевдонимами; неверное отвергается', async () => {
    const partner = await fx.partnerWithAccount('0.45');
    const client = await fx.clientWithMoney('5');
    const alias = await aliasOf(partner.partnerId);

    const saved = await setList(client.token, [{ aliasId: alias, priority: 2 }]);
    expect(saved.statusCode).toBe(200);
    const rows = saved.json<{ priorities: Record<string, unknown>[] }>().priorities;
    expect(rows).toEqual([
      expect.objectContaining({ alias_id: alias, offer: 'message', priority: 2 }),
    ]);
    // Имени и идентификатора партнёра в ответе нет (ADR-0014).
    expect(JSON.stringify(rows)).not.toContain(partner.partnerId);

    // Замена целиком: пустой список снимает всё.
    expect((await setList(client.token, [])).json<{ priorities: unknown[] }>().priorities).toEqual(
      [],
    );

    expect((await setList(client.token, [{ aliasId: alias, priority: 0 }])).statusCode).toBe(400);
    expect((await setList(client.token, [{ aliasId: alias, priority: 100 }])).statusCode).toBe(400);
    expect(
      (
        await setList(client.token, [
          { aliasId: alias, priority: 1 },
          { aliasId: alias, priority: 2 },
        ])
      ).statusCode,
    ).toBe(400);
    // Предложение звонка в списке сообщений — отказ.
    expect(
      (await setList(client.token, [{ aliasId: alias, offer: 'sim', priority: 1 }])).statusCode,
    ).toBe(400);
    expect(
      (
        await setList(client.token, [
          { aliasId: '00000000-0000-4000-8000-000000000000', priority: 1 },
        ])
      ).statusCode,
    ).toBe(404);
    expect((await setList(client.token, [], 'weird')).statusCode).toBe(400);
    // Партнёру и администратору чужой кабинет закрыт.
    expect((await setList(partner.ownerToken, [])).statusCode).toBe(403);
    expect((await setList(adminToken, [])).statusCode).toBe(403);
  });
});

describe('партнёры с ценой сообщения (ADR-0081)', () => {
  it('клиент видит псевдонимы и свою цену, партнёру и чужому кабинету список закрыт', async () => {
    const dear = await fx.partnerWithAccount('0.60');
    const cheap = await fx.partnerWithAccount('0.30');
    const client = await fx.clientWithMoney('5');

    const response = await api().inject({
      method: 'GET',
      url: '/client/messages/offers',
      headers: bearer(client.token),
    });
    expect(response.statusCode).toBe(200);
    const offers = response.json<{
      offers: { alias_id: string; display_name: string; min_price: string; max_price: string }[];
    }>().offers;
    expect(offers.map((offer) => offer.alias_id).sort()).toEqual(
      [await aliasOf(dear.partnerId), await aliasOf(cheap.partnerId)].sort(),
    );
    // Цена клиента — не меньше цены партнёра (наценка внутри), и у одного аккаунта границы равны.
    const byAlias = new Map(offers.map((offer) => [offer.alias_id, offer]));
    const cheapest = byAlias.get(await aliasOf(cheap.partnerId));
    expect(Number(cheapest?.min_price)).toBeGreaterThanOrEqual(0.3);
    expect(cheapest?.min_price).toBe(cheapest?.max_price);
    // Ни идентификатора партнёра, ни его имени (ADR-0014).
    expect(JSON.stringify(offers)).not.toContain(dear.partnerId);

    expect(
      (
        await api().inject({
          method: 'GET',
          url: '/client/messages/offers',
          headers: bearer(dear.ownerToken),
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('выбор аккаунта по приоритетам клиента', () => {
  it('без списка — самый дешёвый; цифра выше цены: первым идёт партнёр с цифрой 1, пока он свободен', async () => {
    const dear = await fx.partnerWithAccount('0.60', { limitPerDay: 1 });
    const cheap = await fx.partnerWithAccount('0.30');
    const client = await fx.clientWithMoney('50');

    expect(await accountOf(await send(client.token))).toBe(cheap.accountId);

    await setList(client.token, [
      { aliasId: await aliasOf(dear.partnerId), priority: 1 },
      { aliasId: await aliasOf(cheap.partnerId), priority: 2 },
    ]);
    // Первая цифра — дорогой партнёр: сообщение уходит к нему, хотя дешёвый есть.
    expect(await accountOf(await send(client.token))).toBe(dear.accountId);
    // Лимит первой цифры исчерпан — следующая цифра, а не ожидание дорогого.
    expect(await accountOf(await send(client.token))).toBe(cheap.accountId);
  });

  it('«не использовать»: партнёр не берётся, даже когда остальные заняты', async () => {
    const first = await fx.partnerWithAccount('0.45', { limitPerDay: 1 });
    const banned = await fx.partnerWithAccount('0.30');
    const client = await fx.clientWithMoney('50');
    await setList(client.token, [
      { aliasId: await aliasOf(first.partnerId), priority: 1 },
      { aliasId: await aliasOf(banned.partnerId), priority: null },
    ]);

    expect(await accountOf(await send(client.token))).toBe(first.accountId);
    // Первый занят, второй отключён клиентом: сообщение ждёт у первого, а не уходит к отключённому.
    expect(await accountOf(await send(client.token))).toBe(first.accountId);
  });

  it('партнёр, которого нет в списке, идёт после названных', async () => {
    const listed = await fx.partnerWithAccount('0.60', { limitPerDay: 1 });
    const unlisted = await fx.partnerWithAccount('0.30');
    const client = await fx.clientWithMoney('50');
    await setList(client.token, [{ aliasId: await aliasOf(listed.partnerId), priority: 1 }]);

    expect(await accountOf(await send(client.token))).toBe(listed.accountId);
    expect(await accountOf(await send(client.token))).toBe(unlisted.accountId);
  });

  it('одна цифра у двоих: сначала дешевле', async () => {
    const dear = await fx.partnerWithAccount('0.60');
    const cheap = await fx.partnerWithAccount('0.30');
    const client = await fx.clientWithMoney('50');
    await setList(client.token, [
      { aliasId: await aliasOf(dear.partnerId), priority: 1 },
      { aliasId: await aliasOf(cheap.partnerId), priority: 1 },
    ]);
    expect(await accountOf(await send(client.token))).toBe(cheap.accountId);
  });
});
