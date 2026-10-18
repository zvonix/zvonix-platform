/**
 * Пробное сообщение партнёра через выбранный аккаунт MAX на реальной базе, провайдер — имитация
 * (ADR-0071, ревизия 2026-10-18).
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
import { simulatedSent } from './simulated.provider.js';
import { TEST_MESSAGES_PER_DAY } from './test-send.service.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const fx = fixtures(api, () => adminToken);
const { user, put, partnerWithAccount } = fx;

const test = (token: string, accountId: string, payload: Record<string, unknown>) =>
  api().inject({
    method: 'POST',
    url: `/partner/messenger/accounts/${accountId}/test`,
    headers: bearer(token),
    payload,
  });

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  adminToken = (await user('admin')).token;
  expect((await put(adminToken, { 'messaging.enabled': true })).statusCode).toBe(200);
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

describe('пробное сообщение через аккаунт', () => {
  it('уходит через выбранный аккаунт, без денег и без строки сообщения', async () => {
    const partner = await partnerWithAccount('0.45');
    simulatedSent.length = 0;

    const response = await test(partner.ownerToken, partner.accountId, {
      recipient: '8 (913) 000-12-34',
      text: 'Привет, это проверка',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sent: true, remaining: TEST_MESSAGES_PER_DAY - 1 });
    expect(simulatedSent.at(-1)).toMatchObject({
      instanceId: partner.instance,
      recipient: '79130001234',
      text: 'Привет, это проверка',
    });

    // Строки сообщения нет: пробное не попадает ни в журнал клиента, ни в расчёты.
    const rows = await withDatabase(async (execute) => {
      const result = await execute(sql`select count(*)::int as n from messages`);
      return result.rows[0] as { n: number };
    });
    expect(rows.n).toBe(0);
  });

  it('без текста уходит «Проверка связи Zvonix»', async () => {
    const partner = await partnerWithAccount('0.45');
    simulatedSent.length = 0;
    expect(
      (await test(partner.ownerToken, partner.accountId, { recipient: '79130001235' })).statusCode,
    ).toBe(200);
    expect(simulatedSent.at(-1)?.text).toBe('Проверка связи Zvonix');
  });

  it('номер не из одиннадцати цифр и номер без MAX — отказ, а попытка не съедает пробные', async () => {
    const partner = await partnerWithAccount('0.45');
    expect(
      (await test(partner.ownerToken, partner.accountId, { recipient: '12345' })).statusCode,
    ).toBe(400);
    // Номера на 0000 имитация считает не имеющими MAX.
    const absent = await test(partner.ownerToken, partner.accountId, { recipient: '79130000000' });
    expect(absent.statusCode).toBe(400);

    const ok = await test(partner.ownerToken, partner.accountId, { recipient: '79130001236' });
    expect(ok.json<{ remaining: number }>().remaining).toBe(TEST_MESSAGES_PER_DAY - 1);
  });

  it('чужой аккаунт — «не найден»', async () => {
    const mine = await partnerWithAccount('0.45');
    const stranger = await partnerWithAccount('0.45');
    const response = await test(stranger.ownerToken, mine.accountId, {
      recipient: '79130001237',
    });
    expect(response.statusCode).toBe(404);
  });

  it('аккаунт, который не вошёл в MAX, — отказ с пояснением', async () => {
    const partner = await partnerWithAccount('0.45');
    await withDatabase(async (execute) => {
      await execute(sql`update messenger_accounts set status = 'pending'`);
    });
    const response = await test(partner.ownerToken, partner.accountId, {
      recipient: '79130001238',
    });
    expect(response.statusCode).toBe(409);
  });

  it('больше семи в сутки на аккаунт нельзя', async () => {
    const partner = await partnerWithAccount('0.45');
    for (let n = 0; n < TEST_MESSAGES_PER_DAY; n += 1) {
      const response = await test(partner.ownerToken, partner.accountId, {
        recipient: `7913000${String(2000 + n)}`,
      });
      expect(response.statusCode).toBe(200);
    }
    const eighth = await test(partner.ownerToken, partner.accountId, { recipient: '79130003000' });
    expect(eighth.statusCode).toBe(429);
    expect(Number(eighth.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('клиенту и администратору маршрут закрыт', async () => {
    const partner = await partnerWithAccount('0.45');
    const client = await user('client');
    expect(
      (await test(client.token, partner.accountId, { recipient: '79130001239' })).statusCode,
    ).toBe(403);
    expect(
      (await test(adminToken, partner.accountId, { recipient: '79130001239' })).statusCode,
    ).toBe(403);
  });
});
