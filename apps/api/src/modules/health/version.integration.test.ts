/**
 * Версия выпуска — только сотрудникам.
 *
 * Номер выпуска подсказывает, какие известные уязвимости пробовать, поэтому адрес
 * не открыт, как `/health/live`. Администратор видит версию в кабинете, поддержка —
 * тоже: ей это нужно, чтобы понимать, с каким выпуском разговаривает клиент.
 * Разбор самого файла `RELEASE` — модульный набор `infra/release.test.ts`; здесь выпуска
 * нет, и версия неизвестна.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { UserRole } from '@zvonix/shared';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
} from '../../testing/harness.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
const tokens = new Map<UserRole, string>();

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

async function versionAs(role: UserRole) {
  return api().inject({
    method: 'GET',
    url: '/health/version',
    headers: { authorization: `Bearer ${tokens.get(role) ?? ''}` },
  });
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  const { IdentityService } = await import('../identity/identity.service.js');
  const identity = api().get(IdentityService);

  for (const role of ['admin', 'support', 'client', 'partner'] as const) {
    const email = uniqueEmail();
    await identity.createByAdmin({
      email,
      password: TEST_PASSWORD,
      fullName: role,
      role,
      status: 'active',
    });
    const response = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
    });
    tokens.set(role, response.json<{ token: string }>().token);
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('GET /health/version', () => {
  it('без входа закрыт — в отличие от проверок живости', async () => {
    expect((await api().inject({ method: 'GET', url: '/health/version' })).statusCode).toBe(401);
  });

  it.each(['client', 'partner'] as const)('%s не видит', async (role) => {
    expect((await versionAs(role)).statusCode).toBe(403);
  });

  it.each(['admin', 'support'] as const)(
    '%s видит; вне выпуска версия неизвестна, а не выдумана',
    async (role) => {
      const response = await versionAs(role);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ version: null, commit: null, builtAt: null });
    },
  );
});
