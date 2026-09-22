/**
 * Сессия в браузере ([ADR-0037](../../../../docs/adr/0037-sessiya-v-brauzere.md)).
 *
 * Сборка и разбор cookie проверены в `session-cookie.test.ts`. Здесь — то, чего
 * там не видно: что вход действительно отвечает `Set-Cookie`, что защитник по ней
 * пускает, что изменяющий запрос без заголовка `X-Zvonix-Web` не проходит,
 * и что негодная cookie снимается, а не остаётся раздражать до ручной чистки.
 *
 * Проверки идут в незащищённой настройке (`WEB_BASE_URL` на `http://127.0.0.1`),
 * потому что такова разработка. Что имя и признак `Secure` следуют за адресом,
 * отвечает модульный набор.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
} from '../testing/harness.js';
import { CSRF_HEADER } from './session-cookie.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

interface Entered {
  readonly token: string;
  /** Пара «имя=значение» из `Set-Cookie` — ровно то, что вернёт браузер. */
  readonly cookie: string;
}

/** Первый заголовок `Set-Cookie` ответа. Их у нас всегда не больше одного. */
function setCookieOf(headers: Record<string, unknown>): string | undefined {
  const value = headers['set-cookie'];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

async function enter(): Promise<Entered> {
  const email = uniqueEmail();
  const { IdentityService } = await import('../modules/identity/identity.service.js');
  await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Владелец',
    role: 'client',
    status: 'active',
  });

  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  expect(response.statusCode).toBe(200);

  const header = setCookieOf(response.headers);
  if (header === undefined) throw new Error('Вход не поставил cookie');
  return { token: response.json<{ token: string }>().token, cookie: header.split(';')[0] ?? '' };
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('выдача', () => {
  it('вход отвечает cookie со всеми признаками защиты', async () => {
    const email = uniqueEmail();
    const { IdentityService } = await import('../modules/identity/identity.service.js');
    await api().get(IdentityService).createByAdmin({
      email,
      password: TEST_PASSWORD,
      fullName: 'Владелец',
      role: 'client',
      status: 'active',
    });

    const response = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
    });

    const cookie = setCookieOf(response.headers);
    expect(cookie).toContain('zvonix_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
  }, 120_000);

  it('неудачный вход cookie не ставит', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: uniqueEmail(), password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(401);
    expect(setCookieOf(response.headers)).toBeUndefined();
  }, 120_000);
});

describe('доступ по cookie', () => {
  it('открывает обработчик так же, как Bearer', async () => {
    const { cookie } = await enter();
    const response = await api().inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(response.statusCode).toBe(200);
  }, 120_000);

  it('без cookie и без заголовка — отказ', async () => {
    const response = await api().inject({ method: 'GET', url: '/auth/me' });
    expect(response.statusCode).toBe(401);
  }, 120_000);

  it('заголовок Bearer главнее cookie', async () => {
    // Забытая в браузере cookie не должна подменять токен, названный явно.
    const first = await enter();
    const second = await enter();

    const response = await api().inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { cookie: second.cookie, authorization: `Bearer ${first.token}` },
    });
    expect(response.statusCode).toBe(200);
    // У каждого входа своя сессия: список из одной строки принадлежит владельцу `Bearer`.
    expect(response.json<{ sessions: unknown[] }>().sessions).toHaveLength(1);
  }, 120_000);
});

describe('защита от подделки запроса', () => {
  it('изменяющий запрос по cookie без заголовка отклоняется', async () => {
    const { cookie } = await enter();
    const response = await api().inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('permission_denied');
  }, 120_000);

  it('с заголовком проходит', async () => {
    const { cookie } = await enter();
    const response = await api().inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, [CSRF_HEADER]: '1' },
    });
    expect(response.statusCode).toBe(204);
  }, 120_000);

  it('запрос по Bearer заголовка не требует', async () => {
    // Чужая страница не может поставить `Authorization`, защищаться там не от чего.
    const { token } = await enter();
    const response = await api().inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(204);
  }, 120_000);

  it('чтение по cookie заголовка не требует', async () => {
    const { cookie } = await enter();
    const response = await api().inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  }, 120_000);
});

describe('снятие', () => {
  it('выход снимает cookie', async () => {
    const { cookie } = await enter();
    const response = await api().inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, [CSRF_HEADER]: '1' },
    });
    expect(setCookieOf(response.headers)).toContain('Max-Age=0');
  }, 120_000);

  it('негодная cookie снимается ответом об отказе', async () => {
    // Иначе кабинет получает отказ на каждом запросе до тех пор, пока человек
    // не догадается почистить хранилище сайта.
    const { cookie } = await enter();
    await api().inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, [CSRF_HEADER]: '1' },
    });

    const response = await api().inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(response.statusCode).toBe(401);
    expect(setCookieOf(response.headers)).toContain('Max-Age=0');
  }, 120_000);

  it('негодный Bearer cookie не трогает', async () => {
    // Снимать нечего: у машины её нет, а лишний `Set-Cookie` в ответе — шум.
    const response = await api().inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer заведомо-негодный' },
    });
    expect(response.statusCode).toBe(401);
    expect(setCookieOf(response.headers)).toBeUndefined();
  }, 120_000);
});
