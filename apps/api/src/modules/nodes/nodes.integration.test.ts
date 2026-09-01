/**
 * Подключение узла АТС на реальной базе (ADR-0009, ADR-0019).
 *
 * Проверяется весь путь из ARCHITECTURE.md: администратор заводит узел → получает команду
 * установки → скрипт обменивает одноразовый токен на постоянный ключ → агент шлёт
 * heartbeat. Одноразовость и вывод из эксплуатации без настоящей PostgreSQL
 * не проверяются вовсе.
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

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let token = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const auth = () => ({ authorization: `Bearer ${token}` });

const bearer = (presented: string) => ({ authorization: `Bearer ${presented}` });

interface NodeView {
  id: string;
  name: string;
  hostname: string | null;
  status: string;
  active_calls: number;
  last_heartbeat_at: string | null;
}

interface Provisioned {
  node: NodeView;
  install: { command: string; token_expires_at: string | null };
}

let counter = 0;

async function provision(payload: Record<string, unknown> = {}): Promise<Provisioned> {
  counter += 1;
  const response = await api().inject({
    method: 'POST',
    url: '/nodes',
    headers: auth(),
    payload: { name: `Узел-${String(counter)}-${String(Date.now())}`, ...payload },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Provisioned>();
}

/** Достаёт предъявляемую часть токена из команды — ровно оттуда, откуда её берёт человек. */
function tokenOf(provisioned: Provisioned): string {
  const command = provisioned.install.command;
  return command.slice(command.lastIndexOf(' ') + 1);
}

async function enroll(presented: string, hostname: string) {
  return api().inject({
    method: 'POST',
    url: '/node/enroll',
    headers: bearer(presented),
    payload: { hostname, agentVersion: '1.0.0' },
  });
}

interface Enrolled {
  node: NodeView;
  key: { key_id: string; secret: string };
  endpoints: Record<string, string>;
}

/** Заводит узел и доводит его до рабочего ключа. */
async function enrolledNode(): Promise<{ nodeId: string; presented: string }> {
  const provisioned = await provision();
  // Имя машины уникально, а первые символы UUIDv7 — это метка времени и у соседних
  // узлов совпадают. Поэтому имя строится из счётчика, а не из идентификатора.
  const response = await enroll(tokenOf(provisioned), `node-auto-${String(counter)}`);
  expect(response.statusCode).toBe(200);
  const enrolled = response.json<Enrolled>();
  return {
    nodeId: provisioned.node.id,
    presented: `${enrolled.key.key_id}.${enrolled.key.secret}`,
  };
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Администратор',
    role: 'admin',
    status: 'active',
  });

  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  token = login.json<{ token: string }>().token;
});

afterAll(async () => {
  await app?.close();
});

describe('заведение узла', () => {
  it('узел появляется в состоянии provisioned и с командой установки', async () => {
    const provisioned = await provision({ sipAddress: 'sip.node-1.example.com' });

    // Запись есть, машина ещё не отвечает — это и означает `provisioned`.
    expect(provisioned.node.status).toBe('provisioned');
    expect(provisioned.node.hostname).toBeNull();
    expect(provisioned.install.command).toContain('install.sh');
    expect(provisioned.install.command).toContain('sudo bash -s --');
    expect(provisioned.install.token_expires_at).not.toBeNull();
  });

  it('в команде одноразовый токен, а не постоянный ключ', async () => {
    // Команда попадает в историю оболочки и в переписку, поэтому в ней не должно быть
    // ничего, что переживает установку.
    const presented = tokenOf(await provision());
    expect(presented).toMatch(/^zvx_enroll_[0-9a-z]{12}\./);
  });

  it('имя узла уникально', async () => {
    const name = `Повтор-${String(Date.now())}`;
    const first = await api().inject({
      method: 'POST',
      url: '/nodes',
      headers: auth(),
      payload: { name },
    });
    expect(first.statusCode).toBe(201);

    const second = await api().inject({
      method: 'POST',
      url: '/nodes',
      headers: auth(),
      payload: { name },
    });
    expect(second.statusCode).toBe(409);
  });

  it('команду установки можно выдать заново: у токена срок час', async () => {
    const provisioned = await provision();
    const again = await api().inject({
      method: 'POST',
      url: `/nodes/${provisioned.node.id}/install-command`,
      headers: auth(),
      payload: {},
    });
    expect(again.statusCode).toBe(201);
    expect(tokenOf(again.json<Provisioned>())).not.toBe(tokenOf(provisioned));
  });
});

describe('регистрация узла', () => {
  it('токен обменивается на рабочий ключ и адреса обработчиков', async () => {
    const provisioned = await provision();
    const response = await enroll(tokenOf(provisioned), 'node-msk-1');
    expect(response.statusCode).toBe(200);

    const enrolled = response.json<Enrolled>();
    expect(enrolled.key.key_id).toMatch(/^zvx_node_/);
    expect(enrolled.key.secret.length).toBeGreaterThan(20);
    expect(enrolled.node.status).toBe('installing');
    expect(enrolled.node.hostname).toBe('node-msk-1');
    // Узел не должен знать адреса из своей конфигурации: их задаёт control plane.
    expect(Object.keys(enrolled.endpoints).sort()).toEqual([
      'cdr',
      'dialplan',
      'directory',
      'heartbeat',
    ]);
  });

  it('выданный ключ ограничен адресом, с которого узел пришёл', async () => {
    const { presented } = await enrolledNode();
    const keyId = presented.slice(0, presented.indexOf('.'));

    const allowed = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select allowed_ips from machine_credentials where key_id = ${keyId}`,
      );
      return (result.rows[0] as { allowed_ips: string[] }).allowed_ips;
    });

    // Ограничение по адресу — единственная мера, работающая и против кражи ключа
    // с самого узла: украденный ключ вне узла бесполезен.
    expect(allowed).toEqual(['127.0.0.1']);
  });

  it('токен применяется ровно один раз даже при одновременных попытках', async () => {
    const provisioned = await provision();
    const presented = tokenOf(provisioned);

    const attempts = await Promise.all([
      enroll(presented, 'node-a'),
      enroll(presented, 'node-b'),
      enroll(presented, 'node-c'),
    ]);

    // Условное обновление, а не проверка перед записью: иначе все три увидели бы
    // «не применён», и три машины получили бы рабочие ключи одного узла.
    expect(attempts.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(attempts.filter((r) => r.statusCode === 409)).toHaveLength(2);
  });

  it('повторная регистрация тем же токеном отвергается и попадает в журнал', async () => {
    const provisioned = await provision();
    const presented = tokenOf(provisioned);

    expect((await enroll(presented, 'node-first')).statusCode).toBe(200);
    expect((await enroll(presented, 'node-second')).statusCode).toBe(409);

    const recorded = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as n from audit_log where action = 'machine_key.enrollment_reused'`,
      );
      return (result.rows[0] as { n: number }).n;
    });
    expect(recorded).toBeGreaterThan(0);
  });

  it('рабочий ключ узла не годится для регистрации', async () => {
    const { presented } = await enrolledNode();
    // Обработчик принимает только токен установки: иначе узел перевыпускал бы себе ключи.
    expect((await enroll(presented, 'node-again')).statusCode).toBe(401);
  });

  it('имя машины уникально между узлами', async () => {
    const first = await provision();
    const second = await provision();
    expect((await enroll(tokenOf(first), 'node-same')).statusCode).toBe(200);

    // Два узла с одним hostname означали бы, что запрос маршрута нельзя достоверно
    // отнести к узлу.
    expect((await enroll(tokenOf(second), 'node-same')).statusCode).toBe(409);
  });
});

describe('heartbeat', () => {
  it('переводит узел в online и отвечает ожидаемым интервалом', async () => {
    const { nodeId, presented } = await enrolledNode();

    const beat = await api().inject({
      method: 'POST',
      url: '/node/heartbeat',
      headers: bearer(presented),
      payload: { activeCalls: 3, degraded: false, agentVersion: '1.0.1' },
    });
    expect(beat.statusCode).toBe(200);

    const body = beat.json<{ status: string; next_heartbeat_in_ms: number }>();
    expect(body.status).toBe('online');
    // Интервал приходит от control plane: иначе изменение порога требует раскатки на узлы.
    expect(body.next_heartbeat_in_ms).toBeGreaterThan(0);

    const listed = await api().inject({ method: 'GET', url: `/nodes/${nodeId}`, headers: auth() });
    const node = listed.json<{ node: NodeView }>().node;
    expect(node.status).toBe('online');
    expect(node.active_calls).toBe(3);
    expect(node.last_heartbeat_at).not.toBeNull();
  });

  it('узел может объявить себя ослабленным', async () => {
    const { nodeId, presented } = await enrolledNode();
    await api().inject({
      method: 'POST',
      url: '/node/heartbeat',
      headers: bearer(presented),
      payload: { activeCalls: 0, degraded: true },
    });

    const listed = await api().inject({ method: 'GET', url: `/nodes/${nodeId}`, headers: auth() });
    expect(listed.json<{ node: NodeView }>().node.status).toBe('degraded');
  });

  it('замолчавший узел снимается с маршрутизации', async () => {
    const { nodeId, presented } = await enrolledNode();
    await api().inject({
      method: 'POST',
      url: '/node/heartbeat',
      headers: bearer(presented),
      payload: { activeCalls: 5, degraded: false },
    });

    // Отматываем последний heartbeat за порог молчания.
    await withDatabase(async (execute) => {
      await execute(
        sql`update nodes set last_heartbeat_at = now() - interval '10 minutes' where id = ${nodeId}`,
      );
    });

    const listed = await api().inject({ method: 'GET', url: '/nodes', headers: auth() });
    const node = listed.json<{ nodes: NodeView[] }>().nodes.find((n) => n.id === nodeId);
    expect(node?.status).toBe('offline');
    // Активные вызовы обнуляются вместе со статусом: на молчащем узле их точно нет.
    expect(node?.active_calls).toBe(0);
  });

  it('узел, ни разу не приславший heartbeat, не считается отказавшим', async () => {
    // Он ещё не выходил в online: его состояние описывает установку, а не отказ.
    const provisioned = await provision();
    await api().inject({ method: 'GET', url: '/nodes', headers: auth() });

    const listed = await api().inject({
      method: 'GET',
      url: `/nodes/${provisioned.node.id}`,
      headers: auth(),
    });
    expect(listed.json<{ node: NodeView }>().node.status).toBe('provisioned');
  });
});

describe('вывод из эксплуатации', () => {
  it('отзывает ключи узла и закрывает запись, но не удаляет её', async () => {
    const { nodeId, presented } = await enrolledNode();

    const closed = await api().inject({
      method: 'POST',
      url: `/nodes/${nodeId}/decommission`,
      headers: auth(),
    });
    expect(closed.statusCode).toBe(201);
    expect(closed.json<{ node: NodeView }>().node.status).toBe('decommissioned');

    // Оставить узел закрытым, а ключи действующими — значит оставить работающий
    // доступ у машины, которой больше нет.
    const beat = await api().inject({
      method: 'POST',
      url: '/node/heartbeat',
      headers: bearer(presented),
      payload: { activeCalls: 0, degraded: false },
    });
    expect(beat.statusCode).toBe(401);

    // Запись остаётся: на узел ссылаются CDR, а их не удаляют никогда.
    const still = await api().inject({ method: 'GET', url: `/nodes/${nodeId}`, headers: auth() });
    expect(still.statusCode).toBe(200);
  });

  it('выведенному узлу новую команду установки не выдать', async () => {
    const { nodeId } = await enrolledNode();
    await api().inject({
      method: 'POST',
      url: `/nodes/${nodeId}/decommission`,
      headers: auth(),
    });

    const again = await api().inject({
      method: 'POST',
      url: `/nodes/${nodeId}/install-command`,
      headers: auth(),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('права', () => {
  it('заводить узлы может только администратор', async () => {
    const { IdentityService } = await import('../identity/identity.service.js');
    const email = uniqueEmail();
    await api().get(IdentityService).createByAdmin({
      email,
      password: TEST_PASSWORD,
      fullName: 'Поддержка',
      role: 'support',
      status: 'active',
    });
    const login = await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
    });
    const supportToken = login.json<{ token: string }>().token;

    const created = await api().inject({
      method: 'POST',
      url: '/nodes',
      headers: { authorization: `Bearer ${supportToken}` },
      payload: { name: `Чужой-${String(Date.now())}` },
    });
    expect(created.statusCode).toBe(403);

    // Смотреть — можно: разбор «почему не звонит» начинается со списка узлов.
    const listed = await api().inject({
      method: 'GET',
      url: '/nodes',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(listed.statusCode).toBe(200);
  });
});
