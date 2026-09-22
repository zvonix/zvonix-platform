/**
 * Первый запуск — `GET/POST /setup` ([ADR-0050](../../../../../docs/adr/0050-ustanovka-odnoy-komandoy-i-pervyy-vhod.md)).
 *
 * Проверяется то, ради чего код вообще заведён: без кода администратор не появляется,
 * с кодом — появляется ровно один, даже из двух одновременных форм, и после этого дверь
 * закрыта навсегда. Порядок проверок в файле значим: до гонки администратора нет,
 * после неё — есть.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  holdTransaction,
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  waitUntilBlocked,
  withDatabase,
} from '../../testing/harness.js';
import { firstRunCode } from './first-run.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const code = (): string => firstRunCode(process.env['SECRET_KEY'] ?? '', new Date()).code;

async function required(): Promise<boolean> {
  const response = await api().inject({ method: 'GET', url: '/setup' });
  expect(response.statusCode).toBe(200);
  return response.json<{ required: boolean }>().required;
}

function submit(payload: Record<string, string>) {
  return api().inject({ method: 'POST', url: '/setup', payload });
}

const draft = (email: string, overrides: Record<string, string> = {}) => ({
  code: code(),
  email,
  password: TEST_PASSWORD,
  fullName: 'Администратор Площадки',
  ...overrides,
});

async function admins(): Promise<{ email: string; status: string }[]> {
  return withDatabase(async (execute) => {
    const { rows } = await execute(
      sql`select email, status from users where role = 'admin' order by created_at`,
    );
    return rows as { email: string; status: string }[];
  });
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
});

afterAll(async () => {
  await app?.close();
});

describe('первый запуск, пока администратора нет', () => {
  it('нужен на пустой площадке', async () => {
    expect(await required()).toBe(true);
  });

  it('самостоятельная регистрация клиента его не закрывает — иначе чужая заявка запирала бы площадку', async () => {
    const { IdentityService } = await import('./identity.service.js');
    await api().get(IdentityService).createByAdmin({
      email: 'client-first-run@example.test',
      password: TEST_PASSWORD,
      fullName: 'Клиент Раньше Админа',
      role: 'client',
      status: 'pending',
    });
    expect(await required()).toBe(true);
  });

  it('неверный код — отказ у поля «Код», администратора нет', async () => {
    const response = await submit(draft('admin-wrong@example.test', { code: 'AAAA-AAAA-AAAA' }));
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string; details: { problems: string[] } } }>();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.problems.join(' ')).toMatch(/^code: /u);
    expect(await admins()).toEqual([]);
  });

  it('короткий пароль отвергается формой запроса, до кода', async () => {
    const response = await submit(draft('admin-short@example.test', { password: 'коротко' }));
    expect(response.statusCode).toBe(400);
    expect(await admins()).toEqual([]);
  });

  it('адрес уже занятой учётной записи — отказ, а не второй человек с тем же адресом', async () => {
    const response = await submit(draft('client-first-run@example.test'));
    expect(response.statusCode).toBe(409);
    expect(await admins()).toEqual([]);
  });

  it('две формы с верным кодом разом — ровно один администратор', async () => {
    // Держатель занимает ту же блокировку, что берёт заведение: обе формы обязаны встать
    // за ним в очередь. Не встали — код блокировку не берёт, и гонка открыта.
    const holder = await holdTransaction(
      sql`select pg_advisory_xact_lock(hashtextextended('first-run', 0))`,
    );
    const first = submit(draft('admin-first@example.test'));
    const second = submit(draft('admin-second@example.test'));
    try {
      const blocked = await waitUntilBlocked({
        blockedBy: [holder.pid],
        until: Promise.all([first, second]),
      });
      expect(blocked, 'форма не встала в очередь за блокировкой первого запуска').not.toBe(
        'settled',
      );
    } finally {
      await holder.release();
    }

    const statuses = (await Promise.all([first, second])).map((response) => response.statusCode);
    expect(statuses.sort()).toEqual([201, 409]);
    const created = await admins();
    expect(created).toHaveLength(1);
    expect(created[0]?.status).toBe('active');
  });
});

describe('после первого запуска', () => {
  it('больше не нужен', async () => {
    expect(await required()).toBe(false);
  });

  it('верный код ничего не открывает: второй администратор этим путём не заводится', async () => {
    const response = await submit(draft('admin-late@example.test'));
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(/уже выполнен/u);
    expect(await admins()).toHaveLength(1);
  });

  it('заведённый администратор входит обычным входом', async () => {
    const [admin] = await admins();
    const response = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: admin?.email, password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: { role: string } }>().user.role).toBe('admin');
  });

  it('заведение записано в журнал — один раз, с адресом источника', async () => {
    const rows = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select actor_user_id, ip from audit_log where action = 'user.first_admin_created'`,
      );
      return result.rows as { actor_user_id: string | null; ip: string | null }[];
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBeNull();
    expect(rows[0]?.ip).not.toBeNull();
  });

  it('заблокированный единственный администратор первый запуск не открывает', async () => {
    await withDatabase(async (execute) => {
      await execute(sql`update users set status = 'suspended' where role = 'admin'`);
    });
    expect(await required()).toBe(false);
    expect((await submit(draft('admin-reopen@example.test'))).statusCode).toBe(409);
  });
});
