/**
 * Обновление из кабинета ([ADR-0074](../../../../../docs/adr/0074-obnovlenie-iz-adminki.md)).
 *
 * API только кладёт заявку в каталог обмена и читает то, что оставила служба обновления, — самой службы
 * здесь нет: её состояние и журнал выкладываются в каталог руками, как это сделала бы она.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('проверка выпуска перед установкой: заявка «подготовить» и результат в обзоре', async () => {
    await mkdir(path.join(root, 'prepared'), { recursive: true });
    await writeFile(
      path.join(root, 'prepared', 'v9.9.9.json'),
      JSON.stringify({
        tag: 'v9.9.9',
        release: '/opt/zvonix/releases/v9.9.9-1',
        ok: false,
        checked_at: new Date().toISOString(),
        checks: [
          { name: 'Место на диске', status: 'ok', detail: 'достаточно' },
          { name: 'Репетиция на копии базы', status: 'fail', detail: 'миграции не прошли' },
          { name: 'мусор', status: 'странно', detail: 'пропускается' },
        ],
      }),
    );

    const overview = (await call('admin', 'GET', '/updates')).json<{
      prepared: { tag: string; ok: boolean; fresh: boolean; checks: { name: string }[] }[];
    }>();
    expect(overview.prepared).toHaveLength(1);
    expect(overview.prepared[0]).toMatchObject({ tag: 'v9.9.9', ok: false, fresh: true });
    expect(overview.prepared[0]?.checks.map((check) => check.name)).toEqual([
      'Место на диске',
      'Репетиция на копии базы',
    ]);

    expect((await call('admin', 'POST', '/updates/prepare', { tag: 'v0.0.1' })).statusCode).toBe(
      404,
    );
    const queued = await call('admin', 'POST', '/updates/prepare', { tag: 'v9.9.9' });
    expect(queued.statusCode).toBe(202);
    const id = queued.json<{ request: { id: string } }>().request.id;
    expect(
      JSON.parse(await readFile(path.join(root, 'requests', `${id}.json`), 'utf8')),
    ).toMatchObject({ action: 'prepare', tag: 'v9.9.9' });
    // Подготовка — тоже выкладка в очереди: вторую не принимаем, отменить можно.
    expect((await call('admin', 'POST', '/updates/deploy', { tag: 'v9.9.8' })).statusCode).toBe(
      409,
    );
    expect((await call('admin', 'POST', `/updates/${id}/cancel`)).statusCode).toBe(204);
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

describe('сертификат (ADR-0083)', () => {
  const DAY = 86_400_000;
  const certificate = (overrides: Record<string, unknown> = {}) => ({
    checked_at: new Date().toISOString(),
    cert_name: 'cp.zvonix.com',
    expected_names: ['cp.zvonix.com', 'zvonix.com'],
    covered_names: ['cp.zvonix.com', 'zvonix.com'],
    present: true,
    not_before: new Date(Date.now() - 30 * DAY).toISOString(),
    not_after: new Date(Date.now() + 60 * DAY).toISOString(),
    issuer: "Let's Encrypt",
    auto_renew: true,
    auto_renew_active: true,
    problem: null,
    ...overrides,
  });

  async function view() {
    return (await call('admin', 'GET', '/certificate')).json<{
      available: boolean;
      state: string;
      days_left: number | null;
      missing_names: string[];
      auto_renew: boolean | null;
      busy: boolean;
    }>();
  }

  async function clearRequests(): Promise<void> {
    const dir = path.join(root, 'requests');
    await mkdir(dir, { recursive: true });
    for (const name of await readdir(dir)) await rm(path.join(dir, name));
  }

  it('закрыт для всех, кроме администратора', async () => {
    expect((await api().inject({ method: 'GET', url: '/certificate' })).statusCode).toBe(401);
    for (const role of ['support', 'client', 'partner'] as const) {
      expect((await call(role, 'GET', '/certificate')).statusCode).toBe(403);
      expect((await call(role, 'POST', '/certificate/issue')).statusCode).toBe(403);
      expect((await call(role, 'POST', '/certificate/auto', { enabled: false })).statusCode).toBe(
        403,
      );
    }
  });

  it('пока служба не прочитала сертификат — «нет данных», а не выдуманное состояние', async () => {
    await rm(path.join(root, 'certificate.json'), { force: true });
    const state = await view();
    expect(state.available).toBe(false);
    expect(state.state).toBe('unknown');
  });

  it('состояние считается по датам и по именам', async () => {
    const file = path.join(root, 'certificate.json');

    await writeFile(file, JSON.stringify(certificate()));
    expect(await view()).toMatchObject({ available: true, state: 'ok', auto_renew: true });

    await writeFile(file, JSON.stringify(certificate({ covered_names: ['cp.zvonix.com'] })));
    expect(await view()).toMatchObject({ state: 'incomplete', missing_names: ['zvonix.com'] });

    await writeFile(
      file,
      JSON.stringify(certificate({ not_after: new Date(Date.now() + 5 * DAY).toISOString() })),
    );
    const soon = await view();
    expect(soon.state).toBe('soon');
    expect(soon.days_left).toBeGreaterThanOrEqual(4);

    await writeFile(
      file,
      JSON.stringify(certificate({ not_after: new Date(Date.now() - DAY).toISOString() })),
    );
    expect((await view()).state).toBe('expired');

    await writeFile(file, JSON.stringify(certificate({ present: false, not_after: null })));
    expect((await view()).state).toBe('missing');

    await writeFile(
      file,
      JSON.stringify(certificate({ cert_name: null, expected_names: [], present: false })),
    );
    expect((await view()).state).toBe('not_configured');
    // Туннель: выпускать сертификат не на что, и заявка не ставится.
    expect((await call('admin', 'POST', '/certificate/issue')).statusCode).toBe(409);
  });

  it('выпуск ставится заявкой без имени домена; повтор, пока заявка ждёт, и сразу после — отказ', async () => {
    await clearRequests();
    await writeFile(path.join(root, 'certificate.json'), JSON.stringify(certificate()));

    const first = await call('admin', 'POST', '/certificate/issue');
    expect(first.statusCode).toBe(202);
    const id = first.json<{ request: { id: string; action: string } }>().request.id;
    const body = JSON.parse(
      await readFile(path.join(root, 'requests', `${id}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(body['action']).toBe('cert-issue');
    // В заявке нет ни домена, ни имён: их служба берёт из своих файлов.
    expect(Object.keys(body).sort()).toEqual(['action', 'at', 'by', 'tag']);
    expect((await view()).busy).toBe(true);

    expect((await call('admin', 'POST', '/certificate/issue')).statusCode).toBe(409);
    await clearRequests();

    // Заявку приняли и выполнили минуту назад: у Let's Encrypt свои пределы, второй выпуск ждёт.
    const done = '33333333-3333-4333-8333-333333333333';
    await mkdir(path.join(root, 'runs', done), { recursive: true });
    await writeFile(
      path.join(root, 'runs', done, 'state.json'),
      JSON.stringify({
        id: done,
        action: 'cert-issue',
        tag: null,
        by: 'admin@example.test',
        requested_at: new Date().toISOString(),
        status: 'succeeded',
        started_at: new Date(Date.now() - 60_000).toISOString(),
        finished_at: new Date().toISOString(),
        exit_code: 0,
      }),
    );
    expect((await call('admin', 'POST', '/certificate/issue')).statusCode).toBe(409);
  });

  it('автопродление включается и выключается заявкой; негодное тело отвергается', async () => {
    await clearRequests();
    const off = await call('admin', 'POST', '/certificate/auto', { enabled: false });
    expect(off.statusCode).toBe(202);
    expect(off.json<{ request: { action: string } }>().request.action).toBe('cert-auto-off');
    await clearRequests();

    const on = await call('admin', 'POST', '/certificate/auto', { enabled: true });
    expect(on.json<{ request: { action: string } }>().request.action).toBe('cert-auto-on');
    await clearRequests();

    expect((await call('admin', 'POST', '/certificate/auto', { enabled: 'да' })).statusCode).toBe(
      400,
    );
    expect(await readdir(path.join(root, 'requests'))).toEqual([]);
  });

  it('проверка — лёгкое действие: ставится, даже когда идёт выкладка', async () => {
    await clearRequests();
    expect((await call('admin', 'POST', '/updates/rollback')).statusCode).toBe(202);
    expect((await call('admin', 'POST', '/certificate/check')).statusCode).toBe(202);
    await clearRequests();
  });
});
