/**
 * Заявки на кабинет ([ADR-0052](../../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 *
 * На настоящей базе: одобрение — одна транзакция через два модуля, и «либо всё,
 * либо ничего» проверяется только ответом самой базы.
 */

import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLIENT_APPLICATION,
  PARTNER_APPLICATION,
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

async function staff(role: 'admin' | 'support'): Promise<Record<string, string>> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Сотрудник',
    role,
    status: 'active',
  });
  return login(email);
}

async function login(email: string): Promise<Record<string, string>> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return { authorization: `Bearer ${response.json<{ token: string }>().token}` };
}

/** Регистрация с заявкой; почта подтверждается записью в базу — письмо здесь не читается. */
async function applicant(
  application: typeof CLIENT_APPLICATION | typeof PARTNER_APPLICATION,
  options: { confirmed?: boolean } = {},
): Promise<{ email: string; applicationId: string }> {
  const email = uniqueEmail();
  const response = await api().inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: TEST_PASSWORD, fullName: 'Анна Заявкина', ...application },
  });
  expect(response.statusCode).toBe(202);

  return withDatabase(async (execute) => {
    if (options.confirmed !== false) {
      await execute(sql`update users set email_confirmed_at = now() where email = ${email}`);
    }
    const found = await execute(sql`
      select a.id from applications a join users u on u.id = a.user_id where u.email = ${email}
    `);
    const row = found.rows[0] as { id: string } | undefined;
    if (row === undefined) throw new Error('Заявка не создана');
    return { email, applicationId: row.id };
  });
}

async function approve(id: string, payload: Record<string, unknown> = {}) {
  return api().inject({
    method: 'POST',
    url: `/applications/${id}/approve`,
    headers: admin,
    payload,
  });
}

async function reject(id: string, note = 'Не удалось связаться по телефону') {
  return api().inject({
    method: 'POST',
    url: `/applications/${id}/reject`,
    headers: admin,
    payload: { note },
  });
}

async function outbox(email: string): Promise<string[]> {
  return withDatabase(async (execute) => {
    const found = await execute(
      sql`select kind from outbox_messages where recipient = ${email} order by created_at`,
    );
    return (found.rows as { kind: string }[]).map((row) => row.kind);
  });
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  admin = await staff('admin');
  support = await staff('support');
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('одобрение', () => {
  it('служба такси: карточка работает сразу, вход открыт, письмо в очереди', async () => {
    const { email, applicationId } = await applicant(CLIENT_APPLICATION);

    // До одобрения войти нельзя: учётная запись ждёт допуска.
    const early = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
    });
    expect(early.statusCode).not.toBe(200);

    const response = await approve(applicationId);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ application: { status: string } }>().application.status).toBe(
      'approved',
    );

    const auth = await login(email);
    const cabinets = (
      await api().inject({ method: 'GET', url: '/me/cabinets', headers: auth })
    ).json<{ cabinets: { client: { name: string; status: string } | null } }>().cabinets;
    expect(cabinets.client).toMatchObject({
      name: CLIENT_APPLICATION.answers.companyName,
      status: 'active',
    });
    expect(await outbox(email)).toContain('application_approved');
  });

  it('партнёр: нужен псевдоним, карточка ждёт проверки оборудования', async () => {
    const { email, applicationId } = await applicant(PARTNER_APPLICATION);

    const without = await approve(applicationId);
    expect(without.statusCode).toBe(400);

    const displayName = unique('Партнёр');
    expect((await approve(applicationId, { displayName })).statusCode).toBe(200);

    const cabinets = (
      await api().inject({ method: 'GET', url: '/me/cabinets', headers: await login(email) })
    ).json<{ cabinets: { partner: { display_name: string; status: string } | null } }>().cabinets;
    expect(cabinets.partner).toEqual(
      expect.objectContaining({ display_name: displayName, status: 'pending' }),
    );
  });

  it('с неподтверждённой почтой — отказ, и ничего не заводится', async () => {
    const { applicationId } = await applicant(CLIENT_APPLICATION, { confirmed: false });

    const response = await approve(applicationId);
    expect(response.statusCode).toBe(409);

    const cards = await withDatabase(async (execute) =>
      execute(sql`
        select count(*)::int as n from clients c
        join applications a on a.user_id = c.owner_user_id where a.id = ${applicationId}
      `),
    );
    expect(cards.rows[0]).toEqual({ n: 0 });
  });

  it('повторное решение по той же заявке — отказ', async () => {
    const { applicationId } = await applicant(CLIENT_APPLICATION);
    expect((await approve(applicationId)).statusCode).toBe(200);
    expect((await approve(applicationId)).statusCode).toBe(409);
    expect((await reject(applicationId)).statusCode).toBe(409);
  });

  it('занятый псевдоним откатывает всё одобрение', async () => {
    const taken = unique('Партнёр');
    const first = await applicant(PARTNER_APPLICATION);
    expect((await approve(first.applicationId, { displayName: taken })).statusCode).toBe(200);

    const second = await applicant(PARTNER_APPLICATION);
    expect((await approve(second.applicationId, { displayName: taken })).statusCode).toBe(409);

    // Заявка осталась в очереди, учётная запись — в ожидании: откатилось всё.
    const state = await withDatabase(async (execute) =>
      execute(sql`
        select a.status, u.status as user_status from applications a
        join users u on u.id = a.user_id where a.id = ${second.applicationId}
      `),
    );
    expect(state.rows[0]).toEqual({ status: 'submitted', user_status: 'pending' });
    expect(
      (await approve(second.applicationId, { displayName: unique('Партнёр') })).statusCode,
    ).toBe(200);
  });

  it('решает только администратор, поддержка очередь только читает', async () => {
    const { applicationId } = await applicant(CLIENT_APPLICATION);

    const list = await api().inject({
      method: 'GET',
      url: '/applications?status=submitted',
      headers: support,
    });
    expect(list.statusCode).toBe(200);
    const queued = list
      .json<{ applications: { id: string; applicant: { email_confirmed: boolean } }[] }>()
      .applications.find((row) => row.id === applicationId);
    expect(queued?.applicant.email_confirmed).toBe(true);

    const attempt = await api().inject({
      method: 'POST',
      url: `/applications/${applicationId}/approve`,
      headers: support,
      payload: {},
    });
    expect(attempt.statusCode).toBe(403);
  });
});

describe('отказ', () => {
  it('вход остаётся закрытым, причина уходит письмом', async () => {
    const { email, applicationId } = await applicant(PARTNER_APPLICATION);

    const response = await reject(applicationId, 'В вашем регионе партнёры пока не нужны');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ application: { decision_note: string } }>().application).toMatchObject({
      status: 'rejected',
      decision_note: 'В вашем регионе партнёры пока не нужны',
    });

    const loginAttempt = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
    });
    expect(loginAttempt.statusCode).not.toBe(200);
    expect(await outbox(email)).toContain('application_rejected');
  });
});

describe('вторая заявка из кабинета', () => {
  it('клиент просит кабинет партнёра тем же входом', async () => {
    const { email, applicationId } = await applicant(CLIENT_APPLICATION);
    expect((await approve(applicationId)).statusCode).toBe(200);
    const auth = await login(email);

    const submitted = await api().inject({
      method: 'POST',
      url: '/me/applications',
      headers: auth,
      payload: PARTNER_APPLICATION,
    });
    expect(submitted.statusCode).toBe(201);
    const second = submitted.json<{ application: { id: string } }>().application.id;

    // Вторая открытая заявка того же вида — отказ.
    const duplicate = await api().inject({
      method: 'POST',
      url: '/me/applications',
      headers: auth,
      payload: PARTNER_APPLICATION,
    });
    expect(duplicate.statusCode).toBe(409);

    expect((await approve(second, { displayName: unique('Партнёр') })).statusCode).toBe(200);
    const cabinets = (
      await api().inject({ method: 'GET', url: '/me/cabinets', headers: auth })
    ).json<{ cabinets: { client: unknown; partner: unknown } }>().cabinets;
    expect(cabinets.client).not.toBeNull();
    expect(cabinets.partner).not.toBeNull();
  });

  it('кабинет, который уже есть, заявкой не просится', async () => {
    const { email, applicationId } = await applicant(CLIENT_APPLICATION);
    expect((await approve(applicationId)).statusCode).toBe(200);

    const response = await api().inject({
      method: 'POST',
      url: '/me/applications',
      headers: await login(email),
      payload: CLIENT_APPLICATION,
    });
    expect(response.statusCode).toBe(409);
  });

  it('сотрудник площадки заявку на кабинет не подаёт', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/me/applications',
      headers: admin,
      payload: CLIENT_APPLICATION,
    });
    expect(response.statusCode).toBe(403);
  });

  it('свою заявку отзывают, пока по ней не решили; чужую — не видно', async () => {
    const { email, applicationId } = await applicant(CLIENT_APPLICATION);
    expect((await approve(applicationId)).statusCode).toBe(200);
    const auth = await login(email);
    const second = (
      await api().inject({
        method: 'POST',
        url: '/me/applications',
        headers: auth,
        payload: PARTNER_APPLICATION,
      })
    ).json<{ application: { id: string } }>().application.id;

    const stranger = await applicant(CLIENT_APPLICATION);
    expect((await approve(stranger.applicationId)).statusCode).toBe(200);
    const foreign = await api().inject({
      method: 'POST',
      url: `/me/applications/${second}/withdraw`,
      headers: await login(stranger.email),
    });
    expect(foreign.statusCode).toBe(404);

    const own = await api().inject({
      method: 'POST',
      url: `/me/applications/${second}/withdraw`,
      headers: auth,
    });
    expect(own.statusCode).toBe(200);
    expect(own.json<{ application: { status: string } }>().application.status).toBe('withdrawn');

    const mine = (
      await api().inject({ method: 'GET', url: '/me/applications', headers: auth })
    ).json<{ applications: { status: string }[] }>().applications;
    expect(mine.map((row) => row.status).sort()).toEqual(['approved', 'withdrawn']);
  });
});

describe('допуск партнёров без администратора (partners.auto_approve)', () => {
  async function setAutoApprove(value: boolean): Promise<void> {
    const response = await api().inject({
      method: 'PUT',
      url: '/settings',
      headers: admin,
      payload: { settings: { 'partners.auto_approve': value } },
    });
    expect(response.statusCode).toBe(200);
  }

  async function runAutoApprove(): Promise<number> {
    const { ApplicationsService } = await import('./applications.service.js');
    return api().get(ApplicationsService).autoApprovePartners();
  }

  afterAll(async () => {
    await setAutoApprove(false);
  });

  it('выключено — заявка ждёт администратора, как всегда', async () => {
    const { applicationId } = await applicant(PARTNER_APPLICATION);
    expect(await runAutoApprove()).toBe(0);
    const status = await withDatabase(async (execute) => {
      const found = await execute(sql`select status from applications where id = ${applicationId}`);
      return (found.rows[0] as { status: string }).status;
    });
    expect(status).toBe('submitted');
  });

  it('включено — партнёр получает кабинет и сразу допущен к работе, журнал без администратора', async () => {
    await setAutoApprove(true);
    const { email, applicationId } = await applicant(PARTNER_APPLICATION);
    const unconfirmed = await applicant(PARTNER_APPLICATION, { confirmed: false });
    const taxi = await applicant(CLIENT_APPLICATION);

    expect(await runAutoApprove()).toBeGreaterThanOrEqual(1);

    const cabinets = (
      await api().inject({ method: 'GET', url: '/me/cabinets', headers: await login(email) })
    ).json<{ cabinets: { partner: { display_name: string; status: string } | null } }>().cabinets;
    expect(cabinets.partner).toEqual(
      expect.objectContaining({
        status: 'verified',
        display_name: expect.stringMatching(/^Партнёр \d{6}$/u) as string,
      }),
    );

    const rows = await withDatabase(async (execute) => {
      const found = await execute(sql`
        select a.id, a.status, a.decided_by_user_id as decided_by from applications a
        where a.id in (${applicationId}, ${unconfirmed.applicationId}, ${taxi.applicationId})
      `);
      return found.rows as { id: string; status: string; decided_by: string | null }[];
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(applicationId)).toMatchObject({ status: 'approved', decided_by: null });
    // Без подтверждённой почты кабинет не открывается — иначе его получал бы любой,
    // вписавший чужой адрес. Службу такси площадка сама не одобряет вовсе.
    expect(byId.get(unconfirmed.applicationId)?.status).toBe('submitted');
    expect(byId.get(taxi.applicationId)?.status).toBe('submitted');

    const audit = await withDatabase(async (execute) => {
      const found = await execute(sql`
        select actor_user_id, after from audit_log
        where action = 'application.approved' and entity_id = ${applicationId}
      `);
      return found.rows[0] as { actor_user_id: string | null; after: { automatic: boolean } };
    });
    expect(audit).toMatchObject({ actor_user_id: null, after: { automatic: true } });
    expect(await outbox(email)).toContain('application_approved');
  });
});
