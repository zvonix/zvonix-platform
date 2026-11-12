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
import type { NodeId } from './nodes.repository.js';

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
  sip_address: string | null;
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

  it('отказ из-за занятого имени не сжигает токен: после переименования та же команда работает', async () => {
    const first = await provision();
    const second = await provision();
    expect((await enroll(tokenOf(first), 'node-burn')).statusCode).toBe(200);

    const refused = await enroll(tokenOf(second), 'node-burn');
    expect(refused.statusCode).toBe(409);
    // Причина названа в ответе, а не «токен уже применён».
    expect(refused.body).toContain('уже занято узлом');

    expect((await enroll(tokenOf(second), 'node-burn-renamed')).statusCode).toBe(200);
  });

  it('удалённый узел освобождает имя машины: переустановка на той же машине проходит', async () => {
    const old = await provision();
    const oldEnrolled = await enroll(tokenOf(old), 'node-reinstall');
    expect(oldEnrolled.statusCode).toBe(200);

    const closed = await api().inject({
      method: 'POST',
      url: `/nodes/${old.node.id}/decommission`,
      headers: auth(),
    });
    expect(closed.statusCode).toBe(201);

    const fresh = await provision();
    expect((await enroll(tokenOf(fresh), 'node-reinstall')).statusCode).toBe(200);
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

describe('установщик без репозитория пакетов', () => {
  it('всё равно отдаётся: решает сам скрипт, а не площадка', async () => {
    // Репозиторий нужен только затем, чтобы **поставить** FreeSWITCH, а стоит он уже
    // или нет — видно только на самой машине
    // ([ADR-0045](../../../../../docs/adr/0045-ustanovshchik-uzla.md), «Ревизия»).
    const response = await api().inject({ method: 'GET', url: '/install.sh' });

    expect(response.statusCode).toBe(200);
    // И отказ на месте: скрипт назовёт незаполненную переменную сам, но только если
    // ставить действительно нужно.
    expect(response.body).toContain('NODE_PACKAGE_REPO_URL');
    expect(response.body).toContain('NEED_PACKAGES=no');
  });

  it('ошибка на обработчике со своим типом ответа приходит конвертом JSON', async () => {
    // Диалплан объявляет `text/xml`, и объявление действует **и на ответ с ошибкой**.
    // Пока фильтр не переставлял тип на JSON, Fastify отказывался слать объект
    // под чужим типом и выдавал `500` поверх настоящей ошибки — в логе их было две.
    const response = await api().inject({ method: 'POST', url: '/node/dialplan', payload: {} });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthenticated');
  });
});

describe('версия набора и автообновление (ADR-0068)', () => {
  const beat = (presented: string, payload: Record<string, unknown>) =>
    api().inject({
      method: 'POST',
      url: '/node/heartbeat',
      headers: bearer(presented),
      payload: { activeCalls: 0, degraded: false, ...payload },
    });

  const setAutoUpdate = (enabled: boolean) =>
    api().inject({
      method: 'PUT',
      url: '/settings',
      headers: auth(),
      payload: { settings: { 'nodes.auto_update': enabled } },
    });

  it('пульс отвечает версией набора площадки, она же вшита в скрипт установки', async () => {
    const { presented } = await enrolledNode();

    const reply = (await beat(presented, {})).json<{ set_version: string; auto_update: boolean }>();
    expect(reply.set_version).toMatch(/^[0-9a-f]{12}$/u);
    expect(reply.auto_update).toBe(false);

    const script = await api().inject({ method: 'GET', url: '/install.sh' });
    expect(script.body).toContain(`ZVONIX_SET_VERSION:-${reply.set_version}}`);
    // Версия не плавает между запросами: узел не должен обновляться «впустую».
    const again = (await beat(presented, {})).json<{ set_version: string }>();
    expect(again.set_version).toBe(reply.set_version);
  });

  it('версия узла запоминается и видна в списке; негодная версия отвергается', async () => {
    const { nodeId, presented } = await enrolledNode();

    expect((await beat(presented, { setVersion: 'abc123def456' })).statusCode).toBe(200);
    const list = await api().inject({ method: 'GET', url: '/nodes', headers: auth() });
    const node = list
      .json<{ nodes: { id: string; set_version: string | null }[] }>()
      .nodes.find((row) => row.id === nodeId);
    expect(node?.set_version).toBe('abc123def456');

    expect((await beat(presented, { setVersion: 'не версия' })).statusCode).toBe(400);
    // Старый узел версию не присылает: прежняя запись стирается, а не остаётся ложно «актуальной».
    await beat(presented, {});
    const after = await api().inject({ method: 'GET', url: `/nodes/${nodeId}`, headers: auth() });
    expect(after.json<{ node: { set_version: string | null } }>().node.set_version).toBeNull();
  });

  it('автообновление включается настройкой, пульс сообщает об этом', async () => {
    const { presented } = await enrolledNode();
    expect((await setAutoUpdate(true)).statusCode).toBe(200);
    expect((await beat(presented, {})).json<{ auto_update: boolean }>().auto_update).toBe(true);
    expect((await setAutoUpdate(false)).statusCode).toBe(200);
    expect((await beat(presented, {})).json<{ auto_update: boolean }>().auto_update).toBe(false);
  });
});

describe('адрес SIP узла и настройки (ADR-0113)', () => {
  const beat = (presented: string, remoteAddress: string) =>
    api().inject({
      method: 'POST',
      url: '/node/heartbeat',
      headers: bearer(presented),
      remoteAddress,
      payload: { activeCalls: 0, degraded: false },
    });
  const nodeOf = async (nodeId: string) =>
    (await api().inject({ method: 'GET', url: `/nodes/${nodeId}`, headers: auth() })).json<{
      node: NodeView;
    }>().node;
  const settings = (nodeId: string, payload: Record<string, unknown>) =>
    api().inject({
      method: 'POST',
      url: `/nodes/${nodeId}/settings`,
      headers: auth(),
      payload,
    });

  /** Узел, установленный с заданного адреса: ключ узла привязан к адресу установки. */
  async function enrolledFrom(remoteAddress: string) {
    const provisioned = await provision();
    const response = await api().inject({
      method: 'POST',
      url: '/node/enroll',
      headers: bearer(tokenOf(provisioned)),
      remoteAddress,
      payload: { hostname: `node-ip-${String(counter)}`, agentVersion: '1.0.0' },
    });
    expect(response.statusCode).toBe(200);
    const enrolled = response.json<Enrolled>();
    return {
      nodeId: provisioned.node.id,
      presented: `${enrolled.key.key_id}.${enrolled.key.secret}`,
    };
  }

  it('адрес берётся из обращения узла сразу при установке; частный — не угадывается', async () => {
    const outside = await enrolledFrom('203.0.113.7');
    expect((await nodeOf(outside.nodeId)).sip_address).toBe('203.0.113.7');

    const inside = await enrolledFrom('192.168.80.94');
    expect((await nodeOf(inside.nodeId)).sip_address).toBeNull();
    expect((await beat(inside.presented, '192.168.80.94')).statusCode).toBe(200);
    expect((await nodeOf(inside.nodeId)).sip_address).toBeNull();
  });

  it('стёртый в настройках адрес определяется заново со следующим пульсом', async () => {
    const node = await enrolledFrom('203.0.113.9');
    const name = (await nodeOf(node.nodeId)).name;
    expect((await settings(node.nodeId, { name, sipAddress: '' })).statusCode).toBe(201);
    expect((await nodeOf(node.nodeId)).sip_address).toBeNull();

    expect((await beat(node.presented, '203.0.113.9')).statusCode).toBe(200);
    expect((await nodeOf(node.nodeId)).sip_address).toBe('203.0.113.9');
  });

  it('заданный адрес пульс не переписывает: правка администратора главнее', async () => {
    const { nodeId, presented } = await enrolledFrom('203.0.113.8');
    const name = (await nodeOf(nodeId)).name;
    const saved = await settings(nodeId, { name, sipAddress: 'sip.zvonix.test' });
    expect(saved.statusCode).toBe(201);
    expect((await beat(presented, '203.0.113.8')).statusCode).toBe(200);
    expect((await nodeOf(nodeId)).sip_address).toBe('sip.zvonix.test');
  });

  it('название и адрес меняются в настройках, и это видно в журнале', async () => {
    const { nodeId } = await enrolledNode();
    const renamed = `Москва-${String(Date.now())}`;
    const saved = await settings(nodeId, { name: renamed, sipAddress: '198.51.100.4:5070' });
    expect(saved.statusCode).toBe(201);
    expect(saved.json<{ node: NodeView }>().node).toMatchObject({
      name: renamed,
      sip_address: '198.51.100.4:5070',
    });
    const journal = await withDatabase(async (execute) =>
      execute(
        sql`select after from audit_log where entity_id = ${nodeId} and action = 'node.settings_changed'`,
      ),
    );
    expect(journal.rows.at(-1)).toMatchObject({
      after: { name: renamed, sip_address: '198.51.100.4:5070' },
    });

    // Адрес со схемой или путём — не адрес SIP.
    expect(
      (await settings(nodeId, { name: renamed, sipAddress: 'http://1.2.3.4/x' })).statusCode,
    ).toBe(400);
  });
});

describe('проверка адреса SIP по DNS (ADR-0113, ревизия)', () => {
  it('отвечает вердиктом и запиcью, которую завести; вводимый адрес проверяется до сохранения', async () => {
    const provisioned = await provision();
    const enrolled = await api().inject({
      method: 'POST',
      url: '/node/enroll',
      headers: bearer(tokenOf(provisioned)),
      remoteAddress: '203.0.113.20',
      payload: { hostname: `node-dns-${String(counter)}`, agentVersion: '1.0.0' },
    });
    expect(enrolled.statusCode).toBe(200);
    const id = provisioned.node.id;

    // Узел установлен с публичного адреса — он и стал адресом SIP: указан IP узла.
    const saved = await api().inject({
      method: 'GET',
      url: `/nodes/${id}/sip-check`,
      headers: auth(),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ check: { verdict: string; expected: string[] } }>().check).toMatchObject({
      verdict: 'ip',
      expected: ['203.0.113.20'],
    });

    // Чужой IP, введённый в окне, — не адрес узла.
    const typed = await api().inject({
      method: 'GET',
      url: `/nodes/${id}/sip-check?address=198.51.100.9`,
      headers: auth(),
    });
    expect(typed.json<{ check: { verdict: string } }>().check.verdict).toBe('ip_mismatch');

    // Список узлов сразу несёт отметку проверки.
    const list = await api().inject({ method: 'GET', url: '/nodes', headers: auth() });
    const row = list
      .json<{
        nodes: { id: string; sip_check: { verdict: string } | null; last_address: string | null }[];
      }>()
      .nodes.find((node) => node.id === id);
    expect(row?.sip_check?.verdict).toBe('ip');
    expect(row?.last_address).toBe('203.0.113.20');
  });
});

describe('команды узлу на отдельной машине (ADR-0115)', () => {
  const commandsOf = async () => {
    const { NodeCommandsService } = await import('./node-commands.service.js');
    return api().get(NodeCommandsService);
  };
  const polled = async (nodeId: string) => {
    const { NodesRepository } = await import('./nodes.repository.js');
    await api()
      .get(NodesRepository)
      .markCommandsPolled(nodeId as NodeId, new Date());
  };
  const take = (presented: string) =>
    api().inject({ method: 'GET', url: '/node/commands', headers: bearer(presented) });
  const result = (presented: string, id: string, body: string) =>
    api().inject({
      method: 'POST',
      url: `/node/commands/${id}/result`,
      headers: { ...bearer(presented), 'content-type': 'text/plain' },
      payload: body,
    });

  it('без ESL и без службы команд узел команд не принимает', async () => {
    const { nodeId } = await enrolledNode();
    const commands = await commandsOf();
    expect(await commands.available(nodeId as NodeId)).toBe(false);
    await expect(commands.run(nodeId as NodeId, 'originate {x}y', 2000)).rejects.toMatchObject({
      failure: 'connect',
    });
  });

  it('служба забирает команду долгим запросом, ответ возвращается вызывающему', async () => {
    const { nodeId, presented } = await enrolledNode();
    const commands = await commandsOf();
    await polled(nodeId);
    expect(await commands.available(nodeId as NodeId)).toBe(true);

    const running = commands.run(nodeId as NodeId, 'originate {a=b}sofia/zvonix/x &park', 10_000);
    const taken = await take(presented);
    expect(taken.statusCode).toBe(200);
    const [id, command] = taken.body.split('\n');
    expect(command).toBe('originate {a=b}sofia/zvonix/x &park');

    expect((await result(presented, id ?? '', '+OK 5f1c\n')).statusCode).toBe(200);
    await expect(running).resolves.toBe('+OK 5f1c');

    // Повторный ответ, чужой узел, неизвестная команда — 404; не текст — 400.
    expect((await result(presented, id ?? '', '+OK')).statusCode).toBe(404);
    const other = await enrolledNode();
    expect((await result(other.presented, id ?? '', '+OK')).statusCode).toBe(404);
    expect(
      (await result(presented, '0190c5a8-0000-7000-8000-000000000000', '+OK')).statusCode,
    ).toBe(404);
    const json = await api().inject({
      method: 'POST',
      url: `/node/commands/${id ?? ''}/result`,
      headers: bearer(presented),
      payload: { reply: '+OK' },
    });
    expect(json.statusCode).toBe(400);
  });

  it('команду, которую узел не забрал вовремя, никто уже не получит', async () => {
    const { nodeId } = await enrolledNode();
    const commands = await commandsOf();
    await polled(nodeId);
    await expect(commands.run(nodeId as NodeId, 'originate {x}y', 1500)).rejects.toMatchObject({
      failure: 'connect',
    });
    const { NodesRepository } = await import('./nodes.repository.js');
    expect(
      await api()
        .get(NodesRepository)
        .claimCommand(nodeId as NodeId, new Date()),
    ).toBeUndefined();
  });

  it('команды старше суток убираются', async () => {
    const commands = await commandsOf();
    const removed = await commands.purge(new Date(Date.now() + 2 * 24 * 60 * 60_000));
    expect(removed).toBeGreaterThan(0);
    expect(await commands.purge(new Date(Date.now() + 2 * 24 * 60 * 60_000))).toBe(0);
  });

  it('без ключа узла — 401', async () => {
    expect((await api().inject({ method: 'GET', url: '/node/commands' })).statusCode).toBe(401);
  });
});
