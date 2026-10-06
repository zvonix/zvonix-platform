/**
 * Обновление из кабинета ([ADR-0074](../../../../../docs/adr/0074-obnovlenie-iz-adminki.md)).
 *
 * API только кладёт заявку в каталог обмена и читает то, что оставила служба обновления, — самой службы
 * здесь нет: её состояние и журнал выкладываются в каталог руками, как это сделала бы она.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
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

const root = mkdtempSync(path.join(tmpdir(), 'zvonix-updater-'));
prepareEnvironment({ UPDATER_DIR: root });

let app: NestFastifyApplication | undefined;
const tokens = new Map<UserRole, string>();

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

const RELEASES = {
  fetched_at: '2026-10-06T10:00:00+00:00',
  releases: [
    {
      tag: 'v9.9.9',
      name: 'v9.9.9',
      published_at: '2026-10-06T09:00:00Z',
      prerelease: false,
      notes: 'Новое',
    },
    {
      tag: 'v9.9.8',
      name: 'v9.9.8',
      published_at: '2026-10-05T09:00:00Z',
      prerelease: false,
      notes: '',
    },
  ],
};

const RUN = '11111111-1111-4111-8111-111111111111';

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
  rmSync(root, { recursive: true, force: true });
});

describe('обновление из кабинета', () => {
  it('закрыто для всех, кроме администратора', async () => {
    expect((await api().inject({ method: 'GET', url: '/updates' })).statusCode).toBe(401);
    for (const role of ['support', 'client', 'partner'] as const) {
      expect((await call(role, 'GET', '/updates')).statusCode).toBe(403);
      expect((await call(role, 'POST', '/updates/rollback')).statusCode).toBe(403);
    }
  });

  it('без каталога обмена отвечает «не настроено» и заявок не берёт', async () => {
    const overview = (await call('admin', 'GET', '/updates')).json<{ available: boolean }>();
    expect(overview.available).toBe(false);
    expect((await call('admin', 'POST', '/updates/deploy', { tag: 'v9.9.9' })).statusCode).toBe(
      409,
    );
  });

  it('с каталогом: список выпусков, заявка, повторная заявка — отказ, отмена', async () => {
    await mkdir(path.join(root, 'requests'), { recursive: true });
    await mkdir(path.join(root, 'runs'), { recursive: true });
    await writeFile(path.join(root, 'releases.json'), JSON.stringify(RELEASES));

    const overview = (await call('admin', 'GET', '/updates')).json<{
      available: boolean;
      releases: { tag: string }[];
    }>();
    expect(overview.available).toBe(true);
    expect(overview.releases.map((item) => item.tag)).toEqual(['v9.9.9', 'v9.9.8']);

    // Метка не из списка и метка со служебными знаками не доходят до службы.
    expect((await call('admin', 'POST', '/updates/deploy', { tag: 'v0.0.1' })).statusCode).toBe(
      404,
    );
    expect((await call('admin', 'POST', '/updates/deploy', { tag: 'v1; reboot' })).statusCode).toBe(
      400,
    );
    expect(await readdir(path.join(root, 'requests'))).toEqual([]);

    const queued = await call('admin', 'POST', '/updates/deploy', { tag: 'v9.9.9' });
    expect(queued.statusCode).toBe(202);
    const id = queued.json<{ request: { id: string } }>().request.id;
    const files = await readdir(path.join(root, 'requests'));
    expect(files).toEqual([`${id}.json`]);
    expect(
      JSON.parse(await readFile(path.join(root, 'requests', `${id}.json`), 'utf8')),
    ).toMatchObject({
      action: 'deploy',
      tag: 'v9.9.9',
    });

    // Пока заявка ждёт, вторая выкладка и откат не принимаются.
    expect((await call('admin', 'POST', '/updates/deploy', { tag: 'v9.9.8' })).statusCode).toBe(
      409,
    );
    expect((await call('admin', 'POST', '/updates/rollback')).statusCode).toBe(409);
    // Обновление списка выпусков очереди не мешает.
    expect((await call('admin', 'POST', '/updates/refresh')).statusCode).toBe(202);

    expect((await call('admin', 'POST', `/updates/${id}/cancel`)).statusCode).toBe(204);
    expect((await call('admin', 'POST', `/updates/${id}/cancel`)).statusCode).toBe(409);
    expect((await call('admin', 'POST', '/updates/не-идентификатор/cancel')).statusCode).toBe(400);

    // Журнал действий: кто и что запросил, и отмена.
    const actions = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select action from audit_log where entity_type = 'update' order by occurred_at`,
      );
      return (result.rows as { action: string }[]).map((row) => row.action);
    });
    expect(actions).toEqual([
      'update.deploy_requested',
      'update.refresh_requested',
      'update.cancelled',
    ]);
  });

  it('журнал выкладки отдаётся кусками и не режет недописанную строку', async () => {
    const run = {
      id: RUN,
      action: 'deploy',
      tag: 'v9.9.9',
      by: 'admin@example.test',
      requested_at: '2026-10-06T10:00:00+00:00',
      status: 'running',
      started_at: '2026-10-06T10:00:01+00:00',
      finished_at: null,
      exit_code: null,
    };
    await mkdir(path.join(root, 'runs', RUN), { recursive: true });
    await writeFile(path.join(root, 'runs', RUN, 'state.json'), JSON.stringify(run));
    await writeFile(path.join(root, 'runs', RUN, 'log'), '=== Копия базы\nидёт дамп');

    const first = (await call('admin', 'GET', `/updates/${RUN}/log?offset=0`)).json<{
      text: string;
      next_offset: number;
    }>();
    // Выкладка идёт: недописанная строка «идёт дамп» ждёт перевода строки.
    expect(first.text).toBe('=== Копия базы\n');
    expect(first.next_offset).toBe(Buffer.byteLength('=== Копия базы\n'));

    await writeFile(
      path.join(root, 'runs', RUN, 'log'),
      '=== Копия базы\nидёт дамп\nDEPLOY_OK v9.9.9\n',
    );
    const second = (
      await call('admin', 'GET', `/updates/${RUN}/log?offset=${String(first.next_offset)}`)
    ).json<{ text: string }>();
    expect(second.text).toBe('идёт дамп\nDEPLOY_OK v9.9.9\n');

    // Закончилась без перевода строки — отдаётся всё, что есть.
    await writeFile(
      path.join(root, 'runs', RUN, 'state.json'),
      JSON.stringify({ ...run, status: 'failed', exit_code: 3 }),
    );
    await writeFile(path.join(root, 'runs', RUN, 'log'), 'ошибка без перевода строки');
    const last = (await call('admin', 'GET', `/updates/${RUN}/log?offset=0`)).json<{
      text: string;
      run: { status: string };
    }>();
    expect(last.text).toBe('ошибка без перевода строки');
    expect(last.run.status).toBe('failed');

    const overview = (await call('admin', 'GET', '/updates')).json<{ runs: { id: string }[] }>();
    expect(overview.runs.map((item) => item.id)).toEqual([RUN]);

    expect(
      (await call('admin', 'GET', '/updates/22222222-2222-4222-8222-222222222222/log')).statusCode,
    ).toBe(404);
    expect((await call('admin', 'GET', '/updates/..%2F..%2Fetc/log')).statusCode).toBe(400);
  });
});
