/**
 * Список учётных записей — `GET /users`.
 *
 * Обработчик закрывает дыру, а не добавляет удобство: заявка на самостоятельную
 * регистрацию создаётся со статусом `pending`, и до него найти её было неоткуда,
 * кроме как запросом к базе. Проверяется именно это — что заявка находится, —
 * и то, что отбор действительно отбирает.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
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
      role: 'partner',
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
    expect(found.users[0]?.role).toBe('partner');
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
