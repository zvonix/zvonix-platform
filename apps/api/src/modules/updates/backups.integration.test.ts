/**
 * Резервные копии из кабинета ([ADR-0086](../../../../../docs/adr/0086-rezervnye-kopii-v-kabinete.md)).
 *
 * API кладёт заявки и читает файлы службы обновления — самой службы здесь нет: её состояние выкладывается в каталог
 * обмена руками, как это сделала бы она.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { UserRole } from '@zvonix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
  withDatabase,
} from '../../testing/harness.js';
import { sql } from 'drizzle-orm';

const root = mkdtempSync(path.join(tmpdir(), 'zvonix-backups-api-'));
prepareEnvironment({ UPDATER_DIR: root });

let app: NestFastifyApplication | undefined;
const tokens = new Map<UserRole, string>();
const emails = new Map<UserRole, string>();

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

function call(role: UserRole, method: 'GET' | 'POST', url: string, payload?: object) {
  return api().inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokens.get(role) ?? ''}`, 'x-zvonix-web': '1' },
    ...(payload === undefined ? {} : { payload }),
  });
}

const DAILY = 'daily/daily-20261019-030000.dump';
const LISTING = {
  generated_at: '2026-10-19T04:00:00+00:00',
  items: [
    {
      id: DAILY,
      kind: 'daily',
      name: 'daily-20261019-030000.dump',
      size: 123456,
      created_at: '2026-10-19T03:00:00+00:00',
      check: { at: '2026-10-19T03:05:00+00:00', ok: true, detail: 'таблиц 14, пользователей 3' },
    },
    {
      id: 'manual/manual-20261018-100000.dump',
      kind: 'manual',
      name: 'manual-20261018-100000.dump',
      size: 99,
      created_at: '2026-10-18T10:00:00+00:00',
      check: null,
    },
  ],
  last_export: null,
};

const requests = async (): Promise<Record<string, unknown>[]> => {
  const dir = path.join(root, 'requests');
  const names = await readdir(dir);
  return Promise.all(
    names.map(
      async (name) =>
        JSON.parse(await readFile(path.join(dir, name), 'utf8')) as Record<string, unknown>,
    ),
  );
};

const clearRequests = async (): Promise<void> => {
  for (const name of await readdir(path.join(root, 'requests'))) {
    rmSync(path.join(root, 'requests', name));
  }
};

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  const { IdentityService } = await import('../identity/identity.service.js');
  const identity = api().get(IdentityService);
  for (const role of ['admin', 'support', 'client', 'partner'] as const) {
    const email = uniqueEmail();
    emails.set(role, email);
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
  rmSync(root, { recursive: true, force: true });
});

describe('резервные копии: доступ', () => {
  it('только администратор', async () => {
    expect((await api().inject({ method: 'GET', url: '/backups' })).statusCode).toBe(401);
    for (const role of ['support', 'client', 'partner'] as const) {
      expect((await call(role, 'GET', '/backups')).statusCode).toBe(403);
      expect((await call(role, 'POST', '/backups/create')).statusCode).toBe(403);
      expect(
        (await call(role, 'POST', '/backups/export', { id: DAILY, password: 'x' })).statusCode,
      ).toBe(403);
    }
  });

  it('без каталога обмена и без списка: «ещё нет данных», заявки не берутся', async () => {
    const listing = (await call('admin', 'GET', '/backups')).json<{
      available: boolean;
      items: unknown[];
    }>();
    expect(listing).toMatchObject({ available: false, items: [] });
    expect((await call('admin', 'POST', '/backups/create')).statusCode).toBe(409);
  });
});

describe('резервные копии: список и заявки', () => {
  beforeAll(async () => {
    await mkdir(path.join(root, 'requests'), { recursive: true });
    await mkdir(path.join(root, 'runs'), { recursive: true });
    await writeFile(path.join(root, 'backups.json'), JSON.stringify(LISTING));
  });

  it('список отдаётся как записала служба, с итогом проверки', async () => {
    const listing = (await call('admin', 'GET', '/backups')).json<{
      available: boolean;
      items: { id: string; check: { ok: boolean } | null }[];
      last_export: unknown;
    }>();
    expect(listing.available).toBe(true);
    expect(listing.items.map((item) => item.id)).toEqual([
      DAILY,
      'manual/manual-20261018-100000.dump',
    ]);
    expect(listing.items[0]?.check?.ok).toBe(true);
    expect(listing.items[1]?.check).toBeNull();
  });

  it('создание и проверка — заявки службе; чужой идентификатор копии — «нет в списке»', async () => {
    const created = await call('admin', 'POST', '/backups/create');
    expect(created.statusCode).toBe(202);
    // Пока заявка ждёт, вторая тяжёлая — отказ: копия и выкладка не должны идти вперемешку.
    expect((await call('admin', 'POST', '/backups/verify', { id: DAILY })).statusCode).toBe(409);
    await clearRequests();

    expect(
      (await call('admin', 'POST', '/backups/verify', { id: '../../etc/passwd' })).statusCode,
    ).toBe(404);
    expect(
      (await call('admin', 'POST', '/backups/verify', { id: 'daily/нет-такой.dump' })).statusCode,
    ).toBe(404);
    expect((await call('admin', 'POST', '/backups/verify', { id: DAILY })).statusCode).toBe(202);
    expect(await requests()).toMatchObject([{ action: 'backup-verify', target: DAILY }]);
    await clearRequests();
  });
});

describe('скачивание копии', () => {
  it('без верного пароля — отказ; пять неудач — и верный пароль на время не проходит', async () => {
    await clearRequests();
    for (let n = 0; n < 5; n += 1) {
      const wrong = await call('admin', 'POST', '/backups/export', {
        id: DAILY,
        password: 'не-тот-пароль',
      });
      expect(wrong.statusCode).toBe(401);
    }
    const blocked = await call('admin', 'POST', '/backups/export', {
      id: DAILY,
      password: TEST_PASSWORD,
    });
    expect(blocked.statusCode).toBe(429);
    expect(await requests()).toEqual([]);
    // Сбрасываем счётчик: дальше проверяется путь с верным паролем.
    const { RedisService } = await import('../../infra/redis.js');
    const redis = api().get(RedisService).connection;
    const keys = await redis.keys('*backup.confirm*');
    if (keys.length > 0) await redis.del(...keys);
  });

  it('верный пароль — заявка с копией; тело ответа не несёт пароля', async () => {
    const response = await call('admin', 'POST', '/backups/export', {
      id: DAILY,
      password: TEST_PASSWORD,
    });
    expect(response.statusCode).toBe(202);
    expect(response.body).not.toContain(TEST_PASSWORD);
    const queued = await requests();
    expect(queued).toMatchObject([{ action: 'backup-export', target: DAILY }]);
    // Пароль в заявку службе не попадает: она проверяет только копию.
    expect(JSON.stringify(queued)).not.toContain(TEST_PASSWORD);
    await clearRequests();
  });

  it('файл выдаётся один раз и только заказавшему, потом удаляется', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    await mkdir(path.join(root, 'runs', id), { recursive: true });
    await mkdir(path.join(root, 'exports'), { recursive: true });
    await writeFile(
      path.join(root, 'runs', id, 'state.json'),
      JSON.stringify({
        id,
        action: 'backup-export',
        tag: null,
        target: DAILY,
        by: emails.get('admin'),
        requested_at: '2026-10-19T04:00:00+00:00',
        status: 'succeeded',
        started_at: '2026-10-19T04:00:01+00:00',
        finished_at: '2026-10-19T04:00:05+00:00',
        exit_code: 0,
      }),
    );
    const file = path.join(root, 'exports', `${id}.dump`);
    await writeFile(file, 'вся-база');

    // Выдана не этому администратору — «не найдено», файл на месте.
    const { IdentityService } = await import('../identity/identity.service.js');
    const otherEmail = uniqueEmail();
    await api().get(IdentityService).createByAdmin({
      email: otherEmail,
      password: TEST_PASSWORD,
      fullName: 'Второй',
      role: 'admin',
      status: 'active',
    });
    const login = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: otherEmail, password: TEST_PASSWORD },
    });
    const stranger = await api().inject({
      method: 'GET',
      url: `/backups/exports/${id}`,
      headers: { authorization: `Bearer ${login.json<{ token: string }>().token}` },
    });
    expect(stranger.statusCode).toBe(404);
    expect(await readFile(file, 'utf8')).toBe('вся-база');

    const download = await call('admin', 'GET', `/backups/exports/${id}`);
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('вся-база');
    expect(download.headers['content-disposition']).toContain(
      'zvonix-daily-daily-20261019-030000.dump',
    );

    // Файл удаляется сразу после потока; ждём закрытия.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!(await readdir(path.join(root, 'exports'))).includes(`${id}.dump`)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await call('admin', 'GET', `/backups/exports/${id}`)).statusCode).toBe(404);

    const audited = await withDatabase(async (execute) => {
      const result = await execute(sql`select action from audit_log where entity_id = ${id}`);
      return (result.rows as { action: string }[]).map((row) => row.action);
    });
    expect(audited).toContain('backup.downloaded');
  });
});
