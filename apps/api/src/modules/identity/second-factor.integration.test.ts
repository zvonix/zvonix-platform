/**
 * Второй фактор и смена пароля (ADR-0028).
 *
 * Проверяется то, что живёт не в алгоритме — он проверен контрольными векторами RFC
 * в `totp.test.ts`, — а в связке с базой и входом: что фактор нельзя включить, не проверив
 * аутентификатор; что после включения пароля мало; что один код не работает дважды;
 * что смена пароля закрывает **прочие** сессии, но не текущую.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
  withDatabase,
} from '../../testing/harness.js';
import { stepAt, totpAt } from './totp.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

interface Account {
  readonly id: string;
  readonly email: string;
  readonly token: string;
  readonly headers: Record<string, string>;
}

async function createAccount(): Promise<Account> {
  const email = uniqueEmail();
  const { IdentityService } = await import('./identity.service.js');
  const created = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Владелец',
    role: 'client',
    status: 'active',
  });

  const token = await login(email, TEST_PASSWORD);
  if (token === undefined) throw new Error('Вход не удался');
  return { id: created.id, email, token, headers: { authorization: `Bearer ${token}` } };
}

/** Вход. `undefined` означает отказ — по какой причине, проверяется отдельно. */
async function login(
  email: string,
  password: string,
  totpCode?: string,
): Promise<string | undefined> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password, ...(totpCode === undefined ? {} : { totpCode }) },
  });
  return response.statusCode === 200 ? response.json<{ token: string }>().token : undefined;
}

async function loginRaw(email: string, password: string, totpCode?: string) {
  return api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password, ...(totpCode === undefined ? {} : { totpCode }) },
  });
}

/** Подключает и подтверждает второй фактор, возвращая секрет. */
async function enableTotp(account: Account): Promise<string> {
  const started = await api().inject({
    method: 'POST',
    url: '/auth/totp',
    headers: account.headers,
  });
  expect(started.statusCode).toBe(200);
  const secret = started.json<{ secret: string }>().secret;

  const confirmed = await api().inject({
    method: 'POST',
    url: '/auth/totp/confirm',
    headers: account.headers,
    payload: { code: totpAt(secret, stepAt(new Date())) },
  });
  expect(confirmed.statusCode).toBe(204);
  return secret;
}

/** Код для шага, отличного от текущего: чтобы не наткнуться на запрет повтора. */
function codeForStep(secret: string, shift: number): string {
  return totpAt(secret, stepAt(new Date()) + shift);
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  const email = uniqueEmail();
  const { IdentityService } = await import('./identity.service.js');
  await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Администратор',
    role: 'admin',
    status: 'active',
  });
  adminToken = (await login(email, TEST_PASSWORD)) ?? '';
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('подключение второго фактора', () => {
  it('до подтверждения кодом фактор не действует', async () => {
    // Иначе человек запер бы себя, не проверив, что аутентификатор показывает
    // верные коды.
    const account = await createAccount();
    const started = await api().inject({
      method: 'POST',
      url: '/auth/totp',
      headers: account.headers,
    });
    expect(started.statusCode).toBe(200);
    expect(started.json<{ otpauth_uri: string }>().otpauth_uri).toContain('otpauth://totp/Zvonix');

    // Вход по одному паролю всё ещё проходит: фактор не подтверждён.
    expect(await login(account.email, TEST_PASSWORD)).toBeDefined();
  }, 120_000);

  it('неверный код при подтверждении не включает фактор', async () => {
    const account = await createAccount();
    await api().inject({ method: 'POST', url: '/auth/totp', headers: account.headers });

    const confirmed = await api().inject({
      method: 'POST',
      url: '/auth/totp/confirm',
      headers: account.headers,
      payload: { code: '000000' },
    });
    expect(confirmed.statusCode).toBe(400);
    expect(await login(account.email, TEST_PASSWORD)).toBeDefined();
  }, 120_000);

  it('секрет в базе лежит зашифрованным', async () => {
    // Смысл шифрования ровно один: утечка одной только базы не даёт генерировать коды.
    const account = await createAccount();
    const secret = await enableTotp(account);

    const stored = await withDatabase(async (execute) => {
      const result = await execute(sql`select totp_secret from users where id = ${account.id}`);
      return (result.rows[0] as { totp_secret: string }).totp_secret;
    });
    expect(stored).not.toContain(secret);
    expect(stored.split(':')).toHaveLength(3);
  }, 120_000);
});

describe('вход со вторым фактором', () => {
  it('одного пароля мало, и это видно только после верного пароля', async () => {
    const account = await createAccount();
    const secret = await enableTotp(account);

    const withoutCode = await loginRaw(account.email, TEST_PASSWORD);
    expect(withoutCode.statusCode).toBe(401);
    expect(
      withoutCode.json<{ error: { details?: { totp_required?: boolean } } }>().error.details,
    ).toMatchObject({ totp_required: true });

    // С неверным паролем про второй фактор не сообщается вовсе: иначе видно,
    // у кого он включён.
    const wrongPassword = await loginRaw(account.email, 'совсем другой пароль');
    expect(wrongPassword.statusCode).toBe(401);
    expect(
      wrongPassword.json<{ error: { details?: { totp_required?: boolean } } }>().error.details
        ?.totp_required,
    ).toBeUndefined();

    // Код следующего шага, а не текущего: шаг, которым подтверждали подключение,
    // уже использован — и это ровно то поведение, ради которого шаг и хранится.
    expect(await login(account.email, TEST_PASSWORD, codeForStep(secret, 1))).toBeDefined();
  }, 120_000);

  it('один код не работает дважды', async () => {
    // RFC 6238, раздел 5.2: подсмотренный код иначе работает все свои тридцать секунд.
    const account = await createAccount();
    const secret = await enableTotp(account);

    const code = codeForStep(secret, 1);
    expect(await login(account.email, TEST_PASSWORD, code)).toBeDefined();
    expect(await login(account.email, TEST_PASSWORD, code)).toBeUndefined();
  }, 120_000);

  it('чужой код не подходит', async () => {
    const account = await createAccount();
    await enableTotp(account);
    const stranger = await createAccount();
    const strangerSecret = await enableTotp(stranger);

    expect(
      await login(account.email, TEST_PASSWORD, totpAt(strangerSecret, stepAt(new Date()) + 1)),
    ).toBeUndefined();
  }, 120_000);
});

describe('отключение второго фактора', () => {
  it('требует и пароль, и код', async () => {
    const account = await createAccount();
    const secret = await enableTotp(account);
    const headers = { authorization: `Bearer ${account.token}` };

    const withoutPassword = await api().inject({
      method: 'DELETE',
      url: '/auth/totp',
      headers,
      payload: { password: 'неверный', code: codeForStep(secret, 1) },
    });
    expect(withoutPassword.statusCode).toBe(401);

    const removed = await api().inject({
      method: 'DELETE',
      url: '/auth/totp',
      headers,
      payload: { password: TEST_PASSWORD, code: codeForStep(secret, 1) },
    });
    expect(removed.statusCode).toBe(204);
    expect(await login(account.email, TEST_PASSWORD)).toBeDefined();
  }, 120_000);

  it('администратор сбрасывает фактор: это путь назад при потерянном телефоне', async () => {
    const account = await createAccount();
    await enableTotp(account);
    expect(await login(account.email, TEST_PASSWORD)).toBeUndefined();

    const reset = await api().inject({
      method: 'DELETE',
      url: `/users/${account.id}/totp`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(reset.statusCode).toBe(204);
    expect(await login(account.email, TEST_PASSWORD)).toBeDefined();
  }, 120_000);

  it('чужой фактор сбросить нельзя никому, кроме администратора', async () => {
    const account = await createAccount();
    const stranger = await createAccount();

    const reset = await api().inject({
      method: 'DELETE',
      url: `/users/${account.id}/totp`,
      headers: stranger.headers,
    });
    expect(reset.statusCode).toBe(403);
  }, 120_000);
});

describe('смена пароля', () => {
  it('закрывает прочие сессии, но не текущую', async () => {
    const account = await createAccount();
    const otherToken = await login(account.email, TEST_PASSWORD);
    expect(otherToken).toBeDefined();

    const changed = await api().inject({
      method: 'POST',
      url: '/auth/password',
      headers: account.headers,
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'другой длинный пароль' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<{ revoked_sessions: number }>().revoked_sessions).toBeGreaterThan(0);

    // Текущая сессия жива: выкидывать человека из устройства, за которым он только что
    // сменил пароль, — способ научить его пароли не менять.
    expect(
      (await api().inject({ method: 'GET', url: '/auth/me', headers: account.headers })).statusCode,
    ).toBe(200);

    // Прочая — нет.
    expect(
      (
        await api().inject({
          method: 'GET',
          url: '/auth/me',
          headers: { authorization: `Bearer ${otherToken ?? ''}` },
        })
      ).statusCode,
    ).toBe(401);

    expect(await login(account.email, 'другой длинный пароль')).toBeDefined();
    expect(await login(account.email, TEST_PASSWORD)).toBeUndefined();
  }, 120_000);

  it('без текущего пароля не меняется', async () => {
    // Украденная сессия иначе превращается в украденную учётную запись одним запросом.
    const account = await createAccount();
    const response = await api().inject({
      method: 'POST',
      url: '/auth/password',
      headers: account.headers,
      payload: { currentPassword: 'не тот пароль', newPassword: 'другой длинный пароль' },
    });
    expect(response.statusCode).toBe(401);
    expect(await login(account.email, TEST_PASSWORD)).toBeDefined();
  }, 120_000);

  it('короткий новый пароль отвергается', async () => {
    const account = await createAccount();
    const response = await api().inject({
      method: 'POST',
      url: '/auth/password',
      headers: account.headers,
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'коротко' },
    });
    expect(response.statusCode).toBe(400);
  }, 120_000);
});
