/**
 * Состояние серверов на реальной базе (ADR-0065): замеры узла и площадки, история, уборка,
 * тревога о диске и пределы настроек хранения.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { parseId } from '@zvonix/shared';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
} from '../../testing/harness.js';
import { ServersRepository } from './servers.repository.js';
import { ServersService } from './servers.service.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminToken = '';
let supportToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const bearer = (presented: string) => ({ authorization: `Bearer ${presented}` });

async function signIn(role: 'admin' | 'support'): Promise<string> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
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

let counter = 0;

/** Узел с рабочим ключом: заведён, установлен, готов слать замеры. */
async function enrolledNode(): Promise<{ nodeId: string; presented: string; name: string }> {
  counter += 1;
  const name = `Сервер-${String(counter)}-${String(Date.now())}`;
  const created = await api().inject({
    method: 'POST',
    url: '/nodes',
    headers: bearer(adminToken),
    payload: { name },
  });
  expect(created.statusCode).toBe(201);
  const provisioned = created.json<{
    node: { id: string };
    install: { command: string };
  }>();
  const command = provisioned.install.command;
  const enrolled = await api().inject({
    method: 'POST',
    url: '/node/enroll',
    headers: bearer(command.slice(command.lastIndexOf(' ') + 1)),
    payload: { hostname: `srv-${String(counter)}`, agentVersion: '1.0.0' },
  });
  expect(enrolled.statusCode).toBe(200);
  const key = enrolled.json<{ key: { key_id: string; secret: string } }>().key;
  return { nodeId: provisioned.node.id, presented: `${key.key_id}.${key.secret}`, name };
}

const metrics = (overrides: Record<string, unknown> = {}) => ({
  load1: 1.25,
  cpuCores: 4,
  memTotalMb: 8000,
  memAvailableMb: 6000,
  diskTotalMb: 100_000,
  diskFreeMb: 60_000,
  activeCalls: 2,
  ...overrides,
});

interface ServerJson {
  scope: string;
  id: string | null;
  name: string;
  stale: boolean;
  current: {
    load1: number;
    cpu_cores: number;
    mem_available_mb: number;
    disk_free_mb: number;
    active_calls: number | null;
  } | null;
  series: { at: string; load1: number }[];
}

async function overview(range = 'day', token = adminToken): Promise<ServerJson[]> {
  const response = await api().inject({
    method: 'GET',
    url: `/servers?range=${range}`,
    headers: bearer(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ servers: ServerJson[] }>().servers;
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  adminToken = await signIn('admin');
  supportToken = await signIn('support');
});

afterAll(async () => {
  await app?.close();
});

describe('замеры узла', () => {
  it('узел присылает замер, и он виден на странице вместе с историей', async () => {
    const { nodeId, presented, name } = await enrolledNode();

    const sent = await api().inject({
      method: 'POST',
      url: '/node/metrics',
      headers: bearer(presented),
      payload: metrics(),
    });
    expect(sent.statusCode).toBe(204);

    const server = (await overview()).find((row) => row.id === nodeId);
    expect(server).toMatchObject({ scope: 'node', name, stale: false });
    expect(server?.current).toMatchObject({
      load1: 1.25,
      cpu_cores: 4,
      mem_available_mb: 6000,
      disk_free_mb: 60_000,
      active_calls: 2,
    });
    expect(server?.series.length).toBeGreaterThanOrEqual(1);
  });

  it('узел без замеров показан как «нет данных», а не пропадает', async () => {
    const { nodeId } = await enrolledNode();
    const server = (await overview()).find((row) => row.id === nodeId);
    expect(server).toMatchObject({ current: null, stale: true, series: [] });
  });

  it('неправдоподобный замер отвергается, чужие роли замеров не шлют', async () => {
    const { presented } = await enrolledNode();
    const send = (payload: Record<string, unknown>, headers: Record<string, string>) =>
      api().inject({ method: 'POST', url: '/node/metrics', headers, payload });

    expect((await send(metrics({ cpuCores: 0 }), bearer(presented))).statusCode).toBe(400);
    expect((await send(metrics({ load1: -1 }), bearer(presented))).statusCode).toBe(400);
    expect((await send(metrics({ diskFreeMb: 'много' }), bearer(presented))).statusCode).toBe(400);
    // Человеческая сессия машинных обработчиков не открывает, и наоборот.
    expect((await send(metrics(), bearer(adminToken))).statusCode).toBe(401);
    expect(
      (await api().inject({ method: 'GET', url: '/servers', headers: bearer(presented) }))
        .statusCode,
    ).toBe(401);
  });

  it('свободного места не больше всего: «свободно» ограничивается объёмом диска', async () => {
    const { nodeId, presented } = await enrolledNode();
    await api().inject({
      method: 'POST',
      url: '/node/metrics',
      headers: bearer(presented),
      payload: metrics({ diskTotalMb: 1000, diskFreeMb: 5000 }),
    });
    const server = (await overview()).find((row) => row.id === nodeId);
    expect(server?.current?.disk_free_mb).toBe(1000);
  });
});

describe('страница «Серверы»', () => {
  it('поддержка читает, без входа — нельзя, окно графика проверяется', async () => {
    expect((await overview('hour', supportToken)).some((row) => row.scope === 'platform')).toBe(
      true,
    );
    expect((await api().inject({ method: 'GET', url: '/servers' })).statusCode).toBe(401);
    expect(
      (
        await api().inject({
          method: 'GET',
          url: '/servers?range=year',
          headers: bearer(adminToken),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('замер самой площадки попадает в историю', async () => {
    await api().get(ServersService).samplePlatform();
    const platform = (await overview()).find((row) => row.scope === 'platform');
    expect(platform?.stale).toBe(false);
    expect(platform?.current?.cpu_cores).toBeGreaterThanOrEqual(1);
    expect(platform?.current?.active_calls).toBeNull();
  });
});

describe('уборка истории и тревога о диске', () => {
  it('старше срока (по умолчанию 14 суток) убирается, свежее остаётся', async () => {
    const { nodeId, presented } = await enrolledNode();
    const servers = api().get(ServersService);
    const principal = { ownerId: nodeId } as never;
    const now = new Date();

    await servers.recordFromNode(principal, metrics(), new Date(now.getTime() - 20 * 86_400_000));
    await api().inject({
      method: 'POST',
      url: '/node/metrics',
      headers: bearer(presented),
      payload: metrics(),
    });

    expect(await servers.purge(now)).toBeGreaterThanOrEqual(1);
    const server = (await overview('week')).find((row) => row.id === nodeId);
    expect(server?.current).not.toBeNull();
    expect(server?.series).toHaveLength(1);
  });

  it('мало места на диске — источник попадает в тревогу, достаточно — нет', async () => {
    const low = await enrolledNode();
    const fine = await enrolledNode();
    const send = (presented: string, diskFreeMb: number) =>
      api().inject({
        method: 'POST',
        url: '/node/metrics',
        headers: bearer(presented),
        payload: metrics({ diskTotalMb: 100_000, diskFreeMb }),
      });
    await send(low.presented, 5000);
    await send(fine.presented, 50_000);

    const found = await api().get(ServersService).lowDisk();
    expect(found.map((row) => row.id)).toContain(low.nodeId);
    expect(found.map((row) => row.id)).not.toContain(fine.nodeId);

    // Замер устарел — молчащий источник другая тревога, а не «мало места».
    const later = new Date(Date.now() + 30 * 60_000);
    expect((await api().get(ServersService).lowDisk(later)).map((row) => row.id)).not.toContain(
      parseId(low.nodeId, 'node'),
    );
  });
});

describe('нагрузка: память и процессор (тревога)', () => {
  it('память занята на 95 % — источник под нагрузкой; процессор — только если перегрузка держится минуты, а не одна точка', async () => {
    const hot = await enrolledNode();
    const spike = await enrolledNode();
    const calm = await enrolledNode();
    const repository = api().get(ServersRepository);
    const now = Date.now();
    const draft = (load1Centi: number, memAvailableMb: number) => ({
      load1Centi,
      cpuCores: 2,
      memTotalMb: 8000,
      memAvailableMb,
      diskTotalMb: 100_000,
      diskFreeMb: 60_000,
      activeCalls: 0,
    });
    // Шесть минут подряд нагрузка 5 на два ядра (2,5 на ядро); память занята на 95 %.
    for (let minute = 6; minute >= 0; minute -= 1) {
      await repository.insert(
        parseId(hot.nodeId, 'node'),
        new Date(now - minute * 60_000),
        draft(500, 400),
      );
    }
    // Одна точка перегрузки среди спокойных — всплеск, а не перегрузка.
    for (let minute = 6; minute >= 1; minute -= 1) {
      await repository.insert(
        parseId(spike.nodeId, 'node'),
        new Date(now - minute * 60_000),
        draft(50, 6000),
      );
    }
    await repository.insert(parseId(spike.nodeId, 'node'), new Date(now), draft(900, 6000));
    for (let minute = 6; minute >= 0; minute -= 1) {
      await repository.insert(
        parseId(calm.nodeId, 'node'),
        new Date(now - minute * 60_000),
        draft(80, 6000),
      );
    }

    const found = await api()
      .get(ServersService)
      .strained(new Date(now + 1000));
    const byId = new Map(found.map((row) => [row.id, row]));
    expect(byId.get(hot.nodeId)).toMatchObject({ memoryUsedPercent: 95 });
    expect(byId.get(hot.nodeId)?.loadPerCore).toBeGreaterThan(2);
    expect(byId.has(spike.nodeId)).toBe(false);
    expect(byId.has(calm.nodeId)).toBe(false);
  });
});

describe('сроки хранения в настройках', () => {
  const put = (settings: Record<string, unknown>) =>
    api().inject({
      method: 'PUT',
      url: '/settings',
      headers: bearer(adminToken),
      payload: { settings },
    });

  it('значение в пределах принимается, за пределами — нет', async () => {
    expect((await put({ 'retention.metrics_days': 0 })).statusCode).toBe(400);
    expect((await put({ 'retention.metrics_days': 91 })).statusCode).toBe(400);
    expect((await put({ 'retention.recordings_days': 3651 })).statusCode).toBe(400);
    expect((await put({ 'retention.metrics_days': 30 })).statusCode).toBe(200);
    expect((await put({ 'retention.recordings_days': 45 })).statusCode).toBe(200);
  });
});
