/**
 * Обязательный второй фактор администраторам (ADR-0067): политика включается настройкой,
 * администратор без фактора после входа может только подключить его, остальные роли не затронуты.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
} from '../../testing/harness.js';
import { stepAt, totpAt } from './totp.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function account(role: 'admin' | 'support' | 'member'): Promise<string> {
  const email = uniqueEmail();
  const { IdentityService } = await import('./identity.service.js');
  await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Сотрудник',
    role,
    status: 'active',
  });
  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return login.json<{ token: string }>().token;
}

const setPolicy = (token: string, required: boolean) =>
  api().inject({
    method: 'PUT',
    url: '/settings',
    headers: bearer(token),
    payload: { settings: { 'security.admin_second_factor_required': required } },
  });

const me = async (token: string) =>
  (await api().inject({ method: 'GET', url: '/auth/me', headers: bearer(token) })).json<{
    user: { totp_enabled: boolean; second_factor_required: boolean };
  }>().user;

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
});

afterAll(async () => {
  await app?.close();
});

describe('политика «второй фактор обязателен администраторам»', () => {
  it('выключена: администратор без фактора работает как раньше', async () => {
    const admin = await account('admin');
    expect(
      (await api().inject({ method: 'GET', url: '/settings', headers: bearer(admin) })).statusCode,
    ).toBe(200);
    expect(await me(admin)).toMatchObject({ totp_enabled: false, second_factor_required: false });
  });

  it('включена: без фактора доступно только подключение, с фактором — всё', async () => {
    const admin = await account('admin');
    expect((await setPolicy(admin, true)).statusCode).toBe(200);

    // Обычный обработчик закрыт, причина названа — по ней кабинет ведёт на подключение.
    const blocked = await api().inject({ method: 'GET', url: '/settings', headers: bearer(admin) });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ error: { details?: { reason?: string } } }>().error.details?.reason).toBe(
      'second_factor_required',
    );
    expect(await me(admin)).toMatchObject({ totp_enabled: false, second_factor_required: true });

    // Подключение остаётся доступным.
    const started = await api().inject({
      method: 'POST',
      url: '/auth/totp',
      headers: bearer(admin),
    });
    expect(started.statusCode).toBe(200);
    const secret = started.json<{ secret: string }>().secret;
    const confirmed = await api().inject({
      method: 'POST',
      url: '/auth/totp/confirm',
      headers: bearer(admin),
      payload: { code: totpAt(secret, stepAt(new Date())) },
    });
    expect(confirmed.statusCode).toBe(204);

    expect(await me(admin)).toMatchObject({ totp_enabled: true, second_factor_required: false });
    expect(
      (await api().inject({ method: 'GET', url: '/settings', headers: bearer(admin) })).statusCode,
    ).toBe(200);

    // Вернуть политику может только администратор с фактором.
    expect((await setPolicy(admin, false)).statusCode).toBe(200);
  });

  it('других ролей политика не касается', async () => {
    const admin = await account('admin');
    const started = await api().inject({
      method: 'POST',
      url: '/auth/totp',
      headers: bearer(admin),
    });
    await api().inject({
      method: 'POST',
      url: '/auth/totp/confirm',
      headers: bearer(admin),
      payload: { code: totpAt(started.json<{ secret: string }>().secret, stepAt(new Date())) },
    });
    expect((await setPolicy(admin, true)).statusCode).toBe(200);

    const support = await account('support');
    const member = await account('member');
    for (const token of [support, member]) {
      expect((await me(token)).second_factor_required).toBe(false);
    }
    expect(
      (await api().inject({ method: 'GET', url: '/payments', headers: bearer(support) }))
        .statusCode,
    ).toBe(200);

    expect((await setPolicy(admin, false)).statusCode).toBe(200);
  });
});
