/**
 * Список учётных записей — `GET /users`.
 *
 * Обработчик закрывает дыру, а не добавляет удобство: заявка на самостоятельную
 * регистрацию создаётся со статусом `pending`, и до него найти её было неоткуда,
 * кроме как запросом к базе. Проверяется именно это — что заявка находится, —
 * и то, что отбор действительно отбирает.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  PARTNER_APPLICATION,
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  withDatabase,
} from '../../testing/harness.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminAuth: Record<string, string> = {};
let supportAuth: Record<string, string> = {};
let clientAuth: Record<string, string> = {};

/** Общий кусок адреса у всех записей набора: чужие адреса в отбор попадать не должны. */
const MARK = `mark${String(Date.now()).slice(-7)}`;

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

interface UserView {
  readonly id: string;
  readonly email: string;
  readonly full_name: string;
  readonly role: string;
  readonly status: string;
  readonly created_at: string;
  readonly email_confirmed_at: string | null;
  readonly totp_enabled: boolean;
  readonly last_login_at: string | null;
  readonly locked_until: string | null;
}

async function create(
  role: 'admin' | 'support' | 'client' | 'partner',
  status: 'pending' | 'active',
  email: string,
): Promise<string> {
  const { IdentityService } = await import('./identity.service.js');
  const created = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Иван Петров',
    role,
    status,
  });
  return created.id;
}

async function authFor(email: string): Promise<Record<string, string>> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return { authorization: `Bearer ${response.json<{ token: string }>().token}` };
}

async function list(
  query: string,
  headers = adminAuth,
): Promise<{ users: UserView[]; total: number }> {
  const response = await api().inject({ method: 'GET', url: `/users?${query}`, headers });
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  const adminEmail = `admin.${MARK}@example.test`;
  await create('admin', 'active', adminEmail);
  adminAuth = await authFor(adminEmail);

  const supportEmail = `support.${MARK}@example.test`;
  await create('support', 'active', supportEmail);
  supportAuth = await authFor(supportEmail);

  const clientEmail = `client.${MARK}@example.test`;
  await create('client', 'active', clientEmail);
  clientAuth = await authFor(clientEmail);

  // Заявка на самостоятельную регистрацию: ровно то, что администратору нужно найти.
  const applied = await api().inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: `applicant.${MARK}@example.test`,
      password: TEST_PASSWORD,
      fullName: 'Пётр Заявкин',
      ...PARTNER_APPLICATION,
    },
  });
  expect(applied.statusCode).toBe(202);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('доступ', () => {
  it('администратор и поддержка видят список', async () => {
    for (const headers of [adminAuth, supportAuth]) {
      const response = await api().inject({ method: 'GET', url: '/users', headers });
      expect(response.statusCode).toBe(200);
    }
  }, 120_000);

  it('клиенту список закрыт', async () => {
    const response = await api().inject({ method: 'GET', url: '/users', headers: clientAuth });
    expect(response.statusCode).toBe(403);
  }, 120_000);

  it('без входа — отказ', async () => {
    const response = await api().inject({ method: 'GET', url: '/users' });
    expect(response.statusCode).toBe(401);
  }, 120_000);
});

describe('отбор', () => {
  it('находит заявку на регистрацию, ради которой всё и делалось', async () => {
    const found = await list(`status=pending&email=${MARK}`);
    expect(found.users).toHaveLength(1);
    expect(found.users[0]?.email).toBe(`applicant.${MARK}@example.test`);
    // Регистрация заводит участника рынка; вид кабинета — в его заявке (ADR-0052).
    expect(found.users[0]?.role).toBe('member');
    // Адрес не подтверждён — главный вопрос при разборе заявки.
    expect(found.users[0]?.email_confirmed_at).toBeNull();
  }, 120_000);

  it('отбирает по роли', async () => {
    const found = await list(`role=support&email=${MARK}`);
    expect(found.users.map((user) => user.role)).toEqual(['support']);
  }, 120_000);

  it('ищет по части адреса, не различая регистра', async () => {
    const lower = await list(`email=applicant.${MARK}`);
    const upper = await list(`email=APPLICANT.${MARK.toUpperCase()}`);
    expect(lower.total).toBe(1);
    expect(upper.total).toBe(1);
  }, 120_000);

  it('знаки шаблона в поиске ничего не значат', async () => {
    // Без экранирования `%` означал бы «любой адрес», и отбор молча перестал бы
    // отбирать — самый неприятный вид ошибки: результат есть, но не тот.
    const found = await list('email=%25');
    expect(found.total).toBe(0);
  }, 120_000);

  it('пустое значение параметра означает «любое»', async () => {
    // Форма отбора шлёт все свои поля; сброс фильтра не должен давать отказ.
    const empty = await list(`role=&status=&email=${MARK}`);
    const none = await list(`email=${MARK}`);
    expect(empty.total).toBe(none.total);
    expect(empty.total).toBe(4);
  }, 120_000);

  it('негодная роль — отказ, а не молчаливый полный список', async () => {
    const response = await api().inject({
      method: 'GET',
      url: '/users?role=НЕТ_ТАКОЙ',
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(400);
  }, 120_000);
});

describe('страницы', () => {
  it('размер страницы ограничивает выборку, но не счёт', async () => {
    const page = await list(`email=${MARK}&limit=2`);
    expect(page.users).toHaveLength(2);
    expect(page.total).toBe(4);
  }, 120_000);

  it('смещение выдаёт следующую страницу без пересечений', async () => {
    const first = await list(`email=${MARK}&limit=2&offset=0`);
    const second = await list(`email=${MARK}&limit=2&offset=2`);
    const ids = new Set([...first.users, ...second.users].map((user) => user.id));
    expect(ids.size).toBe(4);
  }, 120_000);

  it('мусор в границах даёт умолчание, а не отказ', async () => {
    const found = await list(`email=${MARK}&limit=не-число&offset=-5`);
    expect(found.total).toBe(4);
    expect(found.users).toHaveLength(4);
  }, 120_000);
});

describe('состав ответа', () => {
  it('поля названы snake_case, как во всех ответах', async () => {
    const found = await list(`email=admin.${MARK}`);
    const user = found.users[0];
    expect(user).toBeDefined();
    expect(Object.keys(user ?? {}).sort()).toEqual([
      'created_at',
      'email',
      'email_confirmed_at',
      'full_name',
      'id',
      'last_login_at',
      'locked_until',
      'role',
      'status',
      'totp_enabled',
    ]);
  }, 120_000);

  it('секретов в ответе нет ни в каком виде', async () => {
    const response = await api().inject({
      method: 'GET',
      url: `/users?email=${MARK}`,
      headers: adminAuth,
    });
    // Проверяется тело целиком, а не поля поимённо: расширяющая запись `...row`
    // отдала бы хеш пароля молча, и никакая проверка полей этого бы не поймала.
    expect(response.body).not.toContain('passwordHash');
    expect(response.body).not.toContain('password_hash');
    expect(response.body).not.toContain('$argon2');
    expect(response.body).not.toContain('totpSecret');
  }, 120_000);

  it('вход виден: у вошедшего администратора есть время последнего входа', async () => {
    const found = await list(`email=admin.${MARK}`);
    expect(found.users[0]?.last_login_at).not.toBeNull();
  }, 120_000);
});

/**
 * Смена состояния — `PATCH /users/:id/status`.
 *
 * Идёт последним: заводит записи с адресами вне общей метки, чтобы не менять счёт
 * в отборах выше.
 */
describe('смена состояния', () => {
  async function setStatus(id: string, status: string) {
    return api().inject({
      method: 'PATCH',
      url: `/users/${id}/status`,
      headers: adminAuth,
      payload: { status },
    });
  }

  it('свою учётную запись администратор не меняет — ни состояния, ни журнала', async () => {
    // Одно неверное нажатие закрыло бы все сессии разом, а вернуть его мог бы только
    // другой администратор.
    const own = (await list(`email=admin.${MARK}`)).users[0];
    expect(own).toBeDefined();
    const ownId = own?.id ?? '';

    const response = await setStatus(ownId, 'suspended');
    expect(response.statusCode).toBe(409);

    expect((await list(`email=admin.${MARK}`)).users[0]?.status).toBe('active');
    const audited = await withDatabase(async (execute) => {
      const result = await execute(sql`
        select count(*)::int as n from audit_log
         where entity_id = ${ownId} and action = 'user.status_changed'
      `);
      return (result.rows[0] as { n: number }).n;
    });
    expect(audited).toBe(0);
    // И сессия на месте: отказ ничего не закрыл.
    expect(
      (await api().inject({ method: 'GET', url: '/users', headers: adminAuth })).statusCode,
    ).toBe(200);
  }, 120_000);

  it('из `disabled` не возвращается: состояние окончательное', async () => {
    const id = await create('client', 'active', `closed.${String(Date.now())}@example.test`);

    expect((await setStatus(id, 'disabled')).statusCode).toBe(200);
    expect((await setStatus(id, 'active')).statusCode).toBe(409);
    expect((await setStatus(id, 'pending')).statusCode).toBe(409);
    // Повтор того же состояния — не переход, отказывать в нём не за что.
    expect((await setStatus(id, 'disabled')).statusCode).toBe(200);
  }, 120_000);

  it('приостановка по-прежнему закрывает сессии', async () => {
    const email = `paused.${String(Date.now())}@example.test`;
    const id = await create('client', 'active', email);
    const headers = await authFor(email);
    expect((await api().inject({ method: 'GET', url: '/auth/me', headers })).statusCode).toBe(200);

    expect((await setStatus(id, 'suspended')).statusCode).toBe(200);

    const after = await api().inject({ method: 'GET', url: '/auth/me', headers });
    expect([401, 403]).toContain(after.statusCode);
  }, 120_000);
});
