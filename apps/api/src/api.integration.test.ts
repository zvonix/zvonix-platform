/**
 * Сквозные проверки API поверх реальной PostgreSQL (ADR-0006).
 *
 * Поднимается то же приложение, что и в production, — через `buildApplication`.
 * Отдельная тестовая сборка проверяла бы не то, что выкладывается: настройка,
 * включённая только в `main.ts`, не покрыта ни одним тестом и ломается незаметно.
 *
 * Запросы идут через `app.inject()`: настоящий стек Fastify без открытия порта.
 */

import 'reflect-metadata';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, createDatabase } from '@zvonix/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const url =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://zvonix:zvonix@127.0.0.1:5432/zvonix_test';

if (!new URL(url).pathname.endsWith('_test')) {
  throw new Error('Отказ: имя базы не оканчивается на _test');
}

// Конфигурация читается из окружения при сборке приложения (ADR-0002), поэтому
// задаётся до импорта bootstrap — иначе loadConfig отвергнет неполный набор.
process.env['DATABASE_URL'] = url;
process.env['SECRET_KEY'] = 'x'.repeat(32);
process.env['APP_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'error';
process.env['LOG_FORMAT'] = 'json';

const { buildApplication } = await import('./bootstrap.js');
const { IdentityService } = await import('./modules/identity/identity.service.js');

let app: NestFastifyApplication | undefined;

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

let counter = 0;
const uniqueEmail = (): string => `user${String(++counter)}.${String(Date.now())}@example.test`;

const PASSWORD = 'достаточно длинный пароль';

async function register(email: string, role: 'client' | 'partner' = 'client'): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, fullName: 'Иван Петров', role },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ user: { id: string } }>().user.id;
}

/**
 * Активирует запись правкой в базе.
 *
 * Не через администратора: тому пришлось бы заводить учётную запись в каждом тесте,
 * который просто хочет войти. Путь через администратора проверяется отдельно,
 * в «правах администратора».
 */
async function activate(id: string): Promise<void> {
  const handle = createDatabase({ url, poolMax: 1 });
  try {
    await handle.db.execute(sql`update users set status = 'active' where id = ${id}::uuid`);
  } finally {
    await handle.close();
  }
}

async function login(email: string): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string }>().token;
}

beforeAll(async () => {
  const handle = createDatabase({ url, poolMax: 1, statementTimeoutMs: 0 });
  try {
    await handle.db.execute(sql`drop schema if exists public cascade`);
    await handle.db.execute(sql`create schema public`);
    await handle.db.execute(sql`drop schema if exists drizzle cascade`);
    await applyMigrations(handle.db);
  } finally {
    await handle.close();
  }

  const built = await buildApplication();
  app = built.app;
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
});

describe('проверки состояния', () => {
  it('живость отвечает без входа', async () => {
    const response = await api().inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', env: 'test' });
  });

  it('готовность проверяет базу', async () => {
    const response = await api().inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ database: 'ok' });
  });
});

describe('сквозной идентификатор', () => {
  it('возвращается в ответе', async () => {
    const response = await api().inject({ method: 'GET', url: '/health/live' });
    expect(response.headers['x-correlation-id']).toMatch(/.{8,}/);
  });

  it('принимается от клиента, чтобы цепочка не рвалась', async () => {
    const response = await api().inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': 'client-request-0001' },
    });
    expect(response.headers['x-correlation-id']).toBe('client-request-0001');
  });

  it('подменяется своим, если пришёл мусор', async () => {
    // Чужая строка попадёт в наши логи и в журнал аудита, поэтому доверять ей нельзя.
    const response = await api().inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': '<script>' },
    });
    expect(response.headers['x-correlation-id']).not.toBe('<script>');
  });
});

describe('доступ закрыт по умолчанию', () => {
  it('без токена отвечает 401', async () => {
    const response = await api().inject({ method: 'GET', url: '/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('с несуществующим токеном отвечает 401', async () => {
    const response = await api().inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer ' + 'a'.repeat(43) },
    });
    expect(response.statusCode).toBe(401);
  });

  it('в ответе об ошибке есть идентификатор запроса', async () => {
    // Без него обращение в поддержку невозможно связать с записями в логе.
    const response = await api().inject({ method: 'GET', url: '/auth/me' });
    expect(
      response.json<{ error: { correlation_id?: string } }>().error.correlation_id,
    ).toBeDefined();
  });
});

describe('исключения фреймворка приводятся к тому же виду', () => {
  it('несуществующий маршрут — not_found', async () => {
    const response = await api().inject({ method: 'GET', url: '/такого-нет' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('нечитаемое тело — validation_failed', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{ это не json',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('тело сверх предела — ошибка, а не падение процесса', async () => {
    // Без ограничения размера тела публичный обработчик — бесплатный отказ в обслуживании.
    const response = await api().inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.cd', password: 'x'.repeat(400_000) }),
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json()).toHaveProperty('error.code');
  });
});

describe('регистрация', () => {
  it('создаёт запись в состоянии pending', async () => {
    const email = uniqueEmail();
    const response = await api().inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: PASSWORD, fullName: 'Иван Петров', role: 'partner' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ user: { email, role: 'partner', status: 'pending' } });
  });

  it('не отдаёт хеш пароля', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: uniqueEmail(), password: PASSWORD, fullName: 'Иван', role: 'client' },
    });
    expect(response.body).not.toContain('argon2');
    expect(response.body).not.toContain('passwordHash');
  });

  it('отвергает повторный адрес', async () => {
    const email = uniqueEmail();
    await register(email);

    const response = await api().inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: PASSWORD, fullName: 'Другой', role: 'client' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'conflict' } });
  });

  it('отвергает роль администратора', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: uniqueEmail(), password: PASSWORD, fullName: 'Иван', role: 'admin' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('сообщает, какое поле не прошло проверку, не показывая значения', async () => {
    // Значение подобрано так, чтобы не встречаться внутри самих сообщений об ошибке:
    // иначе проверка «значения нет в ответе» ловит собственный текст валидатора.
    const rejectedPassword = 'Hunter2!';
    const response = await api().inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: uniqueEmail(), password: rejectedPassword, fullName: 'И', role: 'client' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { details?: { problems?: string[] } } }>();
    expect(body.error.details?.problems?.join(' ')).toContain('password');
    // Тело запроса содержит пароль, а сообщение об ошибке уходит наружу и попадает
    // в чужие логи: значение не должно возвращаться никогда.
    expect(response.body).not.toContain(rejectedPassword);
  });
});

describe('вход', () => {
  it('не пускает, пока запись не активирована', async () => {
    const email = uniqueEmail();
    await register(email);

    const response = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'permission_denied' } });
  });

  it('выдаёт токен активированной записи', async () => {
    const email = uniqueEmail();
    await activate(await register(email));

    const response = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ token: string; expires_at: string }>();
    expect(body.token).toHaveLength(43);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('отвечает одинаково на неизвестный адрес и на неверный пароль', async () => {
    // Иначе по ответам собирается список зарегистрированных адресов.
    const email = uniqueEmail();
    await activate(await register(email));

    const wrongPassword = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'совершенно другой пароль' },
    });
    const unknownEmail = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: uniqueEmail(), password: PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json<{ error: { message: string } }>().error.message).toBe(
      unknownEmail.json<{ error: { message: string } }>().error.message,
    );
  });
});

describe('сессия', () => {
  it('даёт доступ к своим данным', async () => {
    const email = uniqueEmail();
    await activate(await register(email));
    const token = await login(email);

    const response = await api().inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { email, status: 'active' } });
  });

  it('в списке сессий нет хеша токена', async () => {
    const email = uniqueEmail();
    await activate(await register(email));
    const token = await login(email);

    const response = await api().inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('token_hash');
    expect(response.body).not.toContain('tokenHash');
    const body = response.json<{ sessions: { current: boolean }[] }>();
    expect(body.sessions.filter((session) => session.current)).toHaveLength(1);
  });

  it('после выхода токен перестаёт работать', async () => {
    const email = uniqueEmail();
    await activate(await register(email));
    const token = await login(email);
    const auth = { authorization: `Bearer ${token}` };

    expect(
      (await api().inject({ method: 'POST', url: '/auth/logout', headers: auth })).statusCode,
    ).toBe(204);
    expect((await api().inject({ method: 'GET', url: '/auth/me', headers: auth })).statusCode).toBe(
      401,
    );
  });

  it('нельзя закрыть чужую сессию', async () => {
    const [first, second] = [uniqueEmail(), uniqueEmail()];
    await activate(await register(first));
    await activate(await register(second));

    const victimToken = await login(first);
    const attackerToken = await login(second);

    const victimSessions = await api().inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { authorization: `Bearer ${victimToken}` },
    });
    const victimSessionId = victimSessions.json<{ sessions: { id: string }[] }>().sessions[0]?.id;
    expect(victimSessionId).toBeDefined();

    const response = await api().inject({
      method: 'DELETE',
      url: `/auth/sessions/${victimSessionId ?? ''}`,
      headers: { authorization: `Bearer ${attackerToken}` },
    });

    // not_found, а не 403: иначе по разнице ответов проверяется существование чужих сессий.
    expect(response.statusCode).toBe(404);

    const stillWorks = await api().inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${victimToken}` },
    });
    expect(stillWorks.statusCode).toBe(200);
  });

  it('отвергает идентификатор сессии, не являющийся UUID', async () => {
    const email = uniqueEmail();
    await activate(await register(email));
    const token = await login(email);

    const response = await api().inject({
      method: 'DELETE',
      url: '/auth/sessions/..%2F..%2Fetc%2Fpasswd',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('права администратора', () => {
  it('обычный пользователь не может менять состояние записей', async () => {
    const email = uniqueEmail();
    const targetId = await register(uniqueEmail());
    await activate(await register(email));
    const token = await login(email);

    const response = await api().inject({
      method: 'PATCH',
      url: `/users/${targetId}/status`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'active' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'permission_denied' } });
  });

  it('администратор активирует запись, и та может войти', async () => {
    const adminEmail = uniqueEmail();
    await api().get(IdentityService).createByAdmin({
      email: adminEmail,
      password: PASSWORD,
      fullName: 'Администратор',
      role: 'admin',
      status: 'active',
    });
    const adminToken = await login(adminEmail);

    const partnerEmail = uniqueEmail();
    const partnerId = await register(partnerEmail, 'partner');

    const patched = await api().inject({
      method: 'PATCH',
      url: `/users/${partnerId}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'active' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ user: { status: 'active' } });

    const login2 = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: partnerEmail, password: PASSWORD },
    });
    expect(login2.statusCode).toBe(200);
  });

  it('блокировка немедленно закрывает действующие сессии', async () => {
    // Иначе заблокированный пользователь работает до истечения своего токена — месяц.
    const adminEmail = uniqueEmail();
    await api().get(IdentityService).createByAdmin({
      email: adminEmail,
      password: PASSWORD,
      fullName: 'Администратор',
      role: 'admin',
      status: 'active',
    });
    const adminToken = await login(adminEmail);

    const victimEmail = uniqueEmail();
    const victimId = await register(victimEmail);
    await activate(victimId);
    const victimToken = await login(victimEmail);

    const before = await api().inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${victimToken}` },
    });
    expect(before.statusCode).toBe(200);

    await api().inject({
      method: 'PATCH',
      url: `/users/${victimId}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'suspended' },
    });

    const after = await api().inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${victimToken}` },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('журнал аудита', () => {
  it('записывает регистрацию и вход со сквозным идентификатором', async () => {
    const email = uniqueEmail();
    const id = await register(email);
    await activate(id);
    await login(email);

    const handle = createDatabase({ url, poolMax: 1 });
    try {
      const rows = await handle.db.execute<{ action: string; correlation_id: string | null }>(
        sql`select action, correlation_id from audit_log where actor_user_id = ${id} order by occurred_at`,
      );
      const actions = rows.rows.map((row) => row.action);
      expect(actions).toContain('user.registered');
      expect(actions).toContain('session.created');
      // Строка журнала связывается с записями лога того же запроса напрямую.
      expect(rows.rows.every((row) => row.correlation_id !== null)).toBe(true);
    } finally {
      await handle.close();
    }
  });
});
