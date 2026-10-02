/**
 * Заявки на пополнение на настоящей базе
 * ([ADR-0064](../../../../../docs/adr/0064-platezhi-karkas.md)).
 *
 * Главное, что здесь проверяется, — деньги: заявка зачисляется **ровно один раз**, при любых
 * повторах и гонках, а отказ и отзыв не оставляют после себя ни копейки на счёте.
 */

import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let admin: Record<string, string> = {};
let support: Record<string, string> = {};

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

async function loginAs(role: 'admin' | 'support' | 'member'): Promise<Record<string, string>> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Проверка платежей',
    role,
    status: 'active',
  });
  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return { authorization: `Bearer ${login.json<{ token: string }>().token}` };
}

async function setInstructions(text: string): Promise<void> {
  const response = await api().inject({
    method: 'PUT',
    url: '/settings',
    headers: admin,
    payload: { settings: { 'payments.manual_instructions': text } },
  });
  expect(response.statusCode).toBe(200);
}

/** Клиент с работающей карточкой и своим входом. */
async function createClient(): Promise<{ id: string; headers: Record<string, string> }> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  const user = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Клиент',
    role: 'member',
    status: 'active',
  });
  const created = await api().inject({
    method: 'POST',
    url: '/clients',
    headers: admin,
    payload: { ownerUserId: user.id, name: unique('Клиент') },
  });
  const id = created.json<{ client: { id: string } }>().client.id;
  await api().inject({
    method: 'PATCH',
    url: `/clients/${id}/status`,
    headers: admin,
    payload: { status: 'active' },
  });
  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return { id, headers: { authorization: `Bearer ${login.json<{ token: string }>().token}` } };
}

const open = (client: { headers: Record<string, string> }, amount: string, comment?: string) =>
  api().inject({
    method: 'POST',
    url: '/client/payments',
    headers: client.headers,
    payload: { amount, ...(comment === undefined ? {} : { comment }) },
  });

const decide = (id: string, action: 'confirm' | 'reject', payload: object, headers = admin) =>
  api().inject({ method: 'POST', url: `/payments/${id}/${action}`, headers, payload });

async function balanceOf(clientId: string): Promise<string> {
  const response = await api().inject({
    method: 'GET',
    url: `/clients/${clientId}`,
    headers: admin,
  });
  return response.json<{ client: { balance: string } }>().client.balance;
}

async function paymentEntries(paymentId: string): Promise<number> {
  return withDatabase(async (execute) => {
    const result = await execute(
      sql`select count(*)::int as n from ledger_transactions where idempotency_key = ${`payment:${paymentId}`}`,
    );
    return (result.rows[0] as { n: number }).n;
  });
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  admin = await loginAs('admin');
  support = await loginAs('support');
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('создание заявки', () => {
  it('без реквизитов заявки не принимаются: клиенту было бы нечего переводить', async () => {
    const client = await createClient();
    const response = await open(client, '500');
    expect(response.statusCode).toBe(409);

    const listed = await api().inject({
      method: 'GET',
      url: '/client/payments',
      headers: client.headers,
    });
    expect(listed.json<{ instructions: string }>().instructions).toBe('');
  });

  it('с реквизитами заявка создаётся, и клиент видит реквизиты и свою заявку', async () => {
    await setInstructions('Карта 2200 0000 0000 0000, Иванов И. И.');
    const client = await createClient();

    const created = await open(client, '1500.50', 'платёжка 17');
    expect(created.statusCode).toBe(201);
    const body = created.json<{
      payment: { status: string; amount: string; comment: string };
      instructions: string;
    }>();
    expect(body.payment).toMatchObject({
      status: 'pending',
      amount: '1500.5',
      comment: 'платёжка 17',
    });
    expect(body.instructions).toContain('Карта 2200');

    const listed = await api().inject({
      method: 'GET',
      url: '/client/payments',
      headers: client.headers,
    });
    expect(listed.json<{ payments: unknown[] }>().payments).toHaveLength(1);
  });

  it('сумма вне границ и лишние открытые заявки отвергаются', async () => {
    await setInstructions('Реквизиты');
    const client = await createClient();

    expect((await open(client, '10')).statusCode).toBe(400);
    expect((await open(client, '2000000')).statusCode).toBe(400);
    expect((await open(client, 'много')).statusCode).toBe(400);

    for (let index = 0; index < 5; index += 1) {
      expect((await open(client, '100')).statusCode).toBe(201);
    }
    expect((await open(client, '100')).statusCode).toBe(409);
  });
});

describe('подтверждение', () => {
  it('зачисляет деньги ровно один раз, сколько бы раз ни нажали', async () => {
    await setInstructions('Реквизиты');
    const client = await createClient();
    const before = await balanceOf(client.id);
    const created = await open(client, '1000');
    const id = created.json<{ payment: { id: string } }>().payment.id;

    const first = await decide(id, 'confirm', {});
    expect(first.statusCode).toBe(200);
    expect(
      first.json<{ payment: { status: string; received_amount: string } }>().payment,
    ).toMatchObject({
      status: 'succeeded',
      received_amount: '1000',
    });

    // Повторное нажатие и гонка двух запросов: деньги не удваиваются.
    const second = await decide(id, 'confirm', {});
    expect(second.statusCode).toBe(200);
    await Promise.all([decide(id, 'confirm', {}), decide(id, 'confirm', {})]);

    expect(await paymentEntries(id)).toBe(1);
    expect(Number(await balanceOf(client.id)) - Number(before)).toBe(1000);
  });

  it('зачисляет фактическую сумму, если она отличается от заявленной', async () => {
    await setInstructions('Реквизиты');
    const client = await createClient();
    const before = Number(await balanceOf(client.id));
    const id = (await open(client, '1000')).json<{ payment: { id: string } }>().payment.id;

    const response = await decide(id, 'confirm', { amount: '950.25' });
    expect(response.json<{ payment: { received_amount: string } }>().payment.received_amount).toBe(
      '950.25',
    );
    expect(Number(await balanceOf(client.id)) - before).toBeCloseTo(950.25, 2);
  });

  it('поддержка заявки видит, но решать не может: подтверждение кладёт деньги', async () => {
    await setInstructions('Реквизиты');
    const client = await createClient();
    const id = (await open(client, '300')).json<{ payment: { id: string } }>().payment.id;

    const seen = await api().inject({
      method: 'GET',
      url: '/payments?status=pending',
      headers: support,
    });
    expect(seen.statusCode).toBe(200);
    expect((await decide(id, 'confirm', {}, support)).statusCode).toBe(403);
    expect((await decide(id, 'reject', { reason: 'не пришло' }, support)).statusCode).toBe(403);
  });

  it('подтверждение попадает в журнал вместе с деньгами', async () => {
    await setInstructions('Реквизиты');
    const client = await createClient();
    const id = (await open(client, '400')).json<{ payment: { id: string } }>().payment.id;
    await decide(id, 'confirm', {});

    const logged = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select action from audit_log where entity_id = ${id} order by created_at`,
      );
      return result.rows.map((row) => (row as { action: string }).action);
    });
    expect(logged).toContain('payment.confirmed');
  });
});

describe('отказ и отзыв', () => {
  it('отклонённая заявка денег не даёт, причину видит клиент, подтвердить её уже нельзя', async () => {
    await setInstructions('Реквизиты');
    const client = await createClient();
    const before = await balanceOf(client.id);
    const id = (await open(client, '700')).json<{ payment: { id: string } }>().payment.id;

    expect((await decide(id, 'reject', { reason: 'перевод не поступил' })).statusCode).toBe(200);
    expect((await decide(id, 'confirm', {})).statusCode).toBe(409);
    expect(await paymentEntries(id)).toBe(0);
    expect(await balanceOf(client.id)).toBe(before);

    const listed = await api().inject({
      method: 'GET',
      url: '/client/payments',
      headers: client.headers,
    });
    expect(
      listed.json<{ payments: { resolution_note: string }[] }>().payments[0]?.resolution_note,
    ).toBe('перевод не поступил');
  });

  it('клиент отзывает свою заявку, и после этого её не подтвердить', async () => {
    await setInstructions('Реквизиты');
    const client = await createClient();
    const id = (await open(client, '200')).json<{ payment: { id: string } }>().payment.id;

    const cancelled = await api().inject({
      method: 'POST',
      url: `/client/payments/${id}/cancel`,
      headers: client.headers,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<{ payment: { status: string } }>().payment.status).toBe('cancelled');
    expect((await decide(id, 'confirm', {})).statusCode).toBe(409);
  });

  it('зачисленную заявку отозвать нельзя', async () => {
    await setInstructions('Реквизиты');
    const client = await createClient();
    const id = (await open(client, '250')).json<{ payment: { id: string } }>().payment.id;
    await decide(id, 'confirm', {});

    const response = await api().inject({
      method: 'POST',
      url: `/client/payments/${id}/cancel`,
      headers: client.headers,
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('чужие заявки', () => {
  it('клиент не видит и не отзывает заявки другого клиента', async () => {
    await setInstructions('Реквизиты');
    const owner = await createClient();
    const stranger = await createClient();
    const id = (await open(owner, '500')).json<{ payment: { id: string } }>().payment.id;

    const listed = await api().inject({
      method: 'GET',
      url: '/client/payments',
      headers: stranger.headers,
    });
    expect(listed.json<{ payments: unknown[] }>().payments).toEqual([]);

    const cancel = await api().inject({
      method: 'POST',
      url: `/client/payments/${id}/cancel`,
      headers: stranger.headers,
    });
    // `404`, а не `409`: существование чужой заявки не выдаётся.
    expect(cancel.statusCode).toBe(404);
  });

  it('клиент не заходит в административный список', async () => {
    const client = await createClient();
    const response = await api().inject({
      method: 'GET',
      url: '/payments',
      headers: client.headers,
    });
    expect(response.statusCode).toBe(403);
  });
});
