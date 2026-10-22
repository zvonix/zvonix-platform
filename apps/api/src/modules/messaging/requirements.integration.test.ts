/**
 * Требования клиента к аккаунтам MAX ([ADR-0092](../../../../../docs/adr/0092-trebovaniya-klienta-k-akkauntam.md)): таблица
 * аккаунтов с причинами, фильтр при выборе аккаунта, ручное отключение, отказ «под требования никто не подходит».
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
const { user, put, partnerWithAccount, clientWithMoney } = fx;

interface Offer {
  id: string;
  partner: string;
  number: number;
  price: string;
  stop_line: boolean;
  recommended: boolean;
  excluded: boolean;
  reasons: string[];
}

const accounts = async (token: string) =>
  (
    await api().inject({
      method: 'GET',
      url: '/client/messages/accounts',
      headers: bearer(token),
    })
  ).json<{ requirements: Record<string, unknown>; accounts: Offer[] }>();

const setRequirements = (token: string, body: Record<string, unknown>) =>
  api().inject({
    method: 'PUT',
    url: '/client/messages/requirements',
    headers: bearer(token),
    payload: { stopLine: 'any', recommendedOnly: false, maxPrice: null, minAgeDays: null, ...body },
  });

const send = (token: string, to: string) =>
  api().inject({
    method: 'POST',
    url: '/client/messages',
    headers: bearer(token),
    payload: { to, text: 'Машина подана' },
  });

/** Под каким аккаунтом принято сообщение (через базу: клиенту аккаунт не показывается). */
const accountOfMessage = async (id: string): Promise<string> =>
  withDatabase(async (execute) => {
    const result = await execute(sql`select account_id from messages where id = ${id}`);
    return (result.rows[0] as { account_id: string }).account_id;
  });

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  adminToken = (await user('admin')).token;
  expect((await put(adminToken, { 'messaging.enabled': true })).statusCode).toBe(200);
  expect(
    (
      await put(adminToken, {
        'messages.pace_seconds': 0,
        'messages.recommended_pace_seconds': 0,
        'messages.recommended_per_minute': 0,
        'messages.recommended_per_hour': 0,
        'messages.recommended_per_day': 0,
        'messages.recipient_limit_per_hour': 0,
        'messages.recipient_limit_per_day': 0,
      })
    ).statusCode,
  ).toBe(200);
});

beforeEach(async () => {
  await withDatabase(async (execute) => {
    await execute(sql`delete from messages`);
    await execute(sql`delete from messenger_accounts`);
  });
});

afterAll(async () => {
  await app?.close();
});

describe('требования клиента к аккаунтам MAX', () => {
  it('таблица: псевдоним и «аккаунт N», цена с наценкой, «СТОП»; без названия, номера и провайдера', async () => {
    const withStop = await partnerWithAccount('0.45');
    const withoutStop = await partnerWithAccount('0.40');
    await api().inject({
      method: 'PATCH',
      url: `/partner/messenger/accounts/${withoutStop.accountId}`,
      headers: bearer(withoutStop.ownerToken),
      payload: { stopLine: false },
    });
    const client = await clientWithMoney('10');

    const view = await accounts(client.token);
    expect(view.accounts).toHaveLength(2);
    expect(view.accounts.every((offer) => offer.number === 1 && offer.reasons.length === 0)).toBe(
      true,
    );
    expect(view.accounts.find((offer) => offer.id === withStop.accountId)?.stop_line).toBe(true);
    expect(view.accounts.find((offer) => offer.id === withoutStop.accountId)?.stop_line).toBe(
      false,
    );
    expect(JSON.stringify(view)).not.toMatch(/instance|label|phone|Основной аккаунт|Иванов/iu);
  });

  it('«только со СТОП»: дешёвый аккаунт без «СТОП» не берётся и помечен причиной; отключение вручную; никто не подходит — 409', async () => {
    const withStop = await partnerWithAccount('0.45');
    const withoutStop = await partnerWithAccount('0.40');
    await api().inject({
      method: 'PATCH',
      url: `/partner/messenger/accounts/${withoutStop.accountId}`,
      headers: bearer(withoutStop.ownerToken),
      payload: { stopLine: false },
    });
    const client = await clientWithMoney('10');

    // Без требований — самый дешёвый, без «СТОП».
    const plain = await send(client.token, '79005550301');
    expect(plain.statusCode).toBe(201);
    expect(await accountOfMessage(plain.json<{ message: { id: string } }>().message.id)).toBe(
      withoutStop.accountId,
    );

    expect((await setRequirements(client.token, { stopLine: 'required' })).statusCode).toBe(200);
    const view = await accounts(client.token);
    expect(view.requirements).toMatchObject({ stop_line: 'required' });
    expect(view.accounts.find((offer) => offer.id === withoutStop.accountId)?.reasons).toEqual([
      'без «СТОП»',
    ]);
    const strict = await send(client.token, '79005550302');
    expect(strict.statusCode).toBe(201);
    expect(await accountOfMessage(strict.json<{ message: { id: string } }>().message.id)).toBe(
      withStop.accountId,
    );

    // Отключил единственный подходящий — под требования никто не подходит: 409, а не «повторите позже».
    const off = await api().inject({
      method: 'PUT',
      url: `/client/messages/accounts/${withStop.accountId}/exclusion`,
      headers: bearer(client.token),
      payload: { excluded: true },
    });
    expect(off.statusCode).toBe(200);
    expect(
      (await accounts(client.token)).accounts.find((offer) => offer.id === withStop.accountId)
        ?.excluded,
    ).toBe(true);
    const refused = await send(client.token, '79005550303');
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('требования');

    // Журнал: требования и отключение.
    const actions = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select action from audit_log where action in ('client_message_requirements.set', 'client_account_exclusion.set')`,
      );
      return (result.rows as { action: string }[]).map((row) => row.action).sort();
    });
    expect(actions).toEqual(['client_account_exclusion.set', 'client_message_requirements.set']);
  });

  it('предел цены для клиента считается с наценкой; ниже наценки — никто; неверные значения — 400; партнёру — 403', async () => {
    const cheap = await partnerWithAccount('0.40');
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const prices = (await accounts(client.token)).accounts.map((offer) => offer.price).sort();
    const cheapest = prices[0] ?? '';

    expect((await setRequirements(client.token, { maxPrice: cheapest })).statusCode).toBe(200);
    const view = await accounts(client.token);
    expect(
      view.accounts.filter((offer) => offer.reasons.length === 0).map((offer) => offer.id),
    ).toEqual([cheap.accountId]);
    const accepted = await send(client.token, '79005550311');
    expect(accepted.statusCode).toBe(201);
    expect(await accountOfMessage(accepted.json<{ message: { id: string } }>().message.id)).toBe(
      cheap.accountId,
    );

    expect((await setRequirements(client.token, { maxPrice: '0.01' })).statusCode).toBe(200);
    expect((await send(client.token, '79005550312')).statusCode).toBe(409);

    expect((await setRequirements(client.token, { maxPrice: '0' })).statusCode).toBe(400);
    expect((await setRequirements(client.token, { minAgeDays: 0 })).statusCode).toBe(400);
    expect((await setRequirements(client.token, { stopLine: 'maybe' })).statusCode).toBe(400);
    expect((await setRequirements(cheap.ownerToken, {})).statusCode).toBe(403);
    expect(
      (
        await api().inject({
          method: 'PUT',
          url: '/client/messages/accounts/не-идентификатор/exclusion',
          headers: bearer(client.token),
          payload: { excluded: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api().inject({
          method: 'PUT',
          url: `/client/messages/accounts/${crypto.randomUUID()}/exclusion`,
          headers: bearer(client.token),
          payload: { excluded: true },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('аккаунт моложе предела не берётся', async () => {
    const fresh = await partnerWithAccount('0.40');
    const old = await partnerWithAccount('0.45');
    await withDatabase(async (execute) => {
      await execute(
        sql`update messenger_accounts set created_at = now() - interval '30 days' where id = ${old.accountId}`,
      );
    });
    const client = await clientWithMoney('10');
    expect((await setRequirements(client.token, { minAgeDays: 7 })).statusCode).toBe(200);
    expect(
      (await accounts(client.token)).accounts.find((offer) => offer.id === fresh.accountId)
        ?.reasons,
    ).toEqual(['слишком новый']);
    const accepted = await send(client.token, '79005550321');
    expect(await accountOfMessage(accepted.json<{ message: { id: string } }>().message.id)).toBe(
      old.accountId,
    );
  });
});
