/**
 * Каталог SIP на реальной базе (ADR-0009).
 *
 * Главное свойство, ради которого каталог отдаётся из control plane: заблокировали
 * партнёра — его шлюз перестаёт регистрироваться при следующей же попытке, без раскатки
 * конфигурации на узлы. Проверяется только вживую, потому что держится на запросе
 * с соединением, а не на коде.
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
} from '../../testing/harness.js';

const REALM = 'sip.zvonix.test';
prepareEnvironment({ SIP_REALM: REALM });

let app: NestFastifyApplication | undefined;
let token = '';
let nodeKey = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const auth = () => ({ authorization: `Bearer ${token}` });

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
}

async function createUser(role: 'client' | 'partner'): Promise<string> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const created = await api().get(IdentityService).createByAdmin({
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    fullName: 'Владелец',
    role,
    status: 'active',
  });
  return created.id;
}

async function createPartner(): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/partners',
    headers: auth(),
    payload: {
      ownerUserId: await createUser('partner'),
      name: 'Иванов Иван',
      displayName: unique('Партнёр'),
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ partner: { id: string } }>().partner.id;
}

async function createClient(): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/clients',
    headers: auth(),
    payload: { ownerUserId: await createUser('client'), name: unique('Такси') },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ client: { id: string } }>().client.id;
}

/** Переводит партнёра в `verified`: без этого каталог его шлюз не отдаёт. */
async function verifyPartner(partnerId: string): Promise<void> {
  const { withDatabase } = await import('../../testing/harness.js');
  const { sql } = await import('drizzle-orm');
  await withDatabase(async (execute) => {
    await execute(sql`update partners set status = 'verified' where id = ${partnerId}`);
  });
}

async function activateClient(clientId: string): Promise<void> {
  const { withDatabase } = await import('../../testing/harness.js');
  const { sql } = await import('drizzle-orm');
  await withDatabase(async (execute) => {
    await execute(sql`update clients set status = 'active' where id = ${clientId}`);
  });
}

interface SipAccount {
  username: string;
  password: string;
  realm: string;
}

async function createGateway(
  partnerId: string,
  type: 'goip' | 'android' = 'goip',
): Promise<{ id: string; account: SipAccount }> {
  const response = await api().inject({
    method: 'POST',
    url: '/gateways',
    headers: auth(),
    payload: { partnerId, name: unique('GOIP'), type, portCount: 8 },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ gateway: { id: string }; account: SipAccount }>();
  return { id: body.gateway.id, account: body.account };
}

async function setGatewayStatus(id: string, status: string) {
  return api().inject({
    method: 'POST',
    url: `/gateways/${id}/status`,
    headers: auth(),
    payload: { status },
  });
}

/** Запрос каталога ровно в том виде, в каком его шлёт `mod_xml_curl`. */
async function askDirectory(username: string, key = nodeKey) {
  return api().inject({
    method: 'POST',
    url: '/node/directory',
    headers: {
      authorization: `Basic ${Buffer.from(key, 'utf8').toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams({
      section: 'directory',
      tag_name: 'domain',
      key_name: 'name',
      key_value: REALM,
      user: username,
      domain: REALM,
      action: 'sip_auth',
      hostname: 'node-test',
    }).toString(),
  });
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

  // Узел, от имени которого приходят запросы каталога.
  const provisioned = await api().inject({
    method: 'POST',
    url: '/nodes',
    headers: auth(),
    payload: { name: unique('Узел') },
  });
  expect(provisioned.statusCode).toBe(201);
  const command = provisioned.json<{ install: { command: string } }>().install.command;

  const enrolled = await api().inject({
    method: 'POST',
    url: '/node/enroll',
    headers: { authorization: `Bearer ${command.slice(command.lastIndexOf(' ') + 1)}` },
    payload: { hostname: 'node-test', agentVersion: '1.0.0' },
  });
  expect(enrolled.statusCode).toBe(200);
  const key = enrolled.json<{ key: { key_id: string; secret: string } }>().key;
  nodeKey = `${key.key_id}:${key.secret}`;
});

afterAll(async () => {
  await app?.close();
});

describe('выдача учётных данных', () => {
  it('пароль отдаётся один раз и в базе его нет', async () => {
    const partner = await createPartner();
    const { id, account } = await createGateway(partner);

    expect(account.username).toMatch(/^gw-[a-z0-9]{12}$/);
    expect(account.realm).toBe(REALM);
    expect(account.password.length).toBe(32);

    const listed = await api().inject({ method: 'GET', url: '/gateways', headers: auth() });
    expect(listed.statusCode).toBe(200);
    // Ни пароля, ни хеша в ответах наружу быть не должно.
    expect(listed.body).not.toContain(account.password);
    expect(listed.body).not.toContain('a1_hash');

    const { withDatabase } = await import('../../testing/harness.js');
    const { sql } = await import('drizzle-orm');
    const stored = await withDatabase(async (execute) => {
      const result = await execute(sql`select a1_hash from gateways where id = ${id}`);
      return (result.rows[0] as { a1_hash: string }).a1_hash;
    });

    // В базе — MD5(имя:realm:пароль), а не пароль.
    expect(stored).toBe(
      createHash('md5')
        .update(`${account.username}:${REALM}:${account.password}`, 'utf8')
        .digest('hex'),
    );
    expect(stored).not.toContain(account.password);
  });

  it('новый пароль шлюза: имя прежнее, в каталоге — хеш нового пароля', async () => {
    const partner = await createPartner();
    await verifyPartner(partner);
    const { id, account } = await createGateway(partner);
    await setGatewayStatus(id, 'active');
    expect((await askDirectory(account.username)).body).toContain('<user id=');

    const reset = await api().inject({
      method: 'POST',
      url: `/gateways/${id}/credentials`,
      headers: auth(),
    });
    expect(reset.statusCode).toBe(201);
    const fresh = reset.json<{ account: SipAccount }>().account;

    // Меняется только пароль: имя уже введено в устройство (владелец, 2026-09-25).
    expect(fresh.username).toBe(account.username);
    expect(fresh.password).not.toBe(account.password);
    const served = (await askDirectory(account.username)).body;
    expect(served).toContain(
      createHash('md5')
        .update(`${fresh.username}:${REALM}:${fresh.password}`, 'utf8')
        .digest('hex'),
    );
    expect(served).not.toContain(
      createHash('md5')
        .update(`${account.username}:${REALM}:${account.password}`, 'utf8')
        .digest('hex'),
    );
  });

  it('перевыпуск доступа канала отзывает старый пароль', async () => {
    // Симметрично шлюзу. Утёкший пароль канала — это чужие вызовы **за счёт клиента**,
    // и без перевыпуска единственным ответом на утечку было бы отключение канала целиком.
    const client = await createClient();
    await activateClient(client);

    const created = await api().inject({
      method: 'POST',
      url: '/channels',
      headers: auth(),
      payload: { clientId: client, name: unique('Линия'), recordingRequired: false },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ channel: { id: string }; account: SipAccount }>();

    await api().inject({
      method: 'POST',
      url: `/channels/${body.channel.id}/status`,
      headers: auth(),
      payload: { status: 'active' },
    });
    expect((await askDirectory(body.account.username)).body).toContain('<user id=');

    const reset = await api().inject({
      method: 'POST',
      url: `/channels/${body.channel.id}/credentials`,
      headers: auth(),
    });
    expect(reset.statusCode).toBe(201);
    const fresh = reset.json<{ account: SipAccount }>().account;

    expect(fresh.username).not.toBe(body.account.username);
    expect(fresh.password).not.toBe(body.account.password);
    // Старое имя перестаёт находиться в каталоге — это и есть отзыв доступа.
    expect((await askDirectory(body.account.username)).body).toContain('not found');
    expect((await askDirectory(fresh.username)).body).toContain('<user id=');
  });

  it('перевыпуск несуществующего канала — 404', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/channels/01890a5d-ac96-774b-bcce-b302099a8057/credentials',
      headers: auth(),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('каталог для узла', () => {
  it('отдаёт a1-hash, а не пароль, и код 200', async () => {
    const partner = await createPartner();
    await verifyPartner(partner);
    const { id, account } = await createGateway(partner);
    await setGatewayStatus(id, 'active');

    const response = await askDirectory(account.username);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('xml');
    expect(response.body).toContain('name="a1-hash"');
    expect(response.body).not.toContain('name="password"');
    expect(response.body).not.toContain(account.password);
    expect(response.body).toContain(`<user id="${account.username}">`);
    expect(response.body).toContain(`zvonix_gateway`);
  });

  it('неподтверждённый шлюз не выдаётся', async () => {
    const partner = await createPartner();
    await verifyPartner(partner);
    // Состояние по умолчанию — `pending`: учётная запись есть, каталог её не отдаёт.
    const { account } = await createGateway(partner);
    expect((await askDirectory(account.username)).body).toContain('not found');
  });

  it('заблокированный ПАРТНЁР перестаёт регистрироваться, хотя шлюз активен', async () => {
    const partner = await createPartner();
    await verifyPartner(partner);
    const { id, account } = await createGateway(partner);
    await setGatewayStatus(id, 'active');
    expect((await askDirectory(account.username)).body).toContain('<user id=');

    const { withDatabase } = await import('../../testing/harness.js');
    const { sql } = await import('drizzle-orm');
    await withDatabase(async (execute) => {
      await execute(sql`update partners set status = 'suspended' where id = ${partner}`);
    });

    // Ради этого свойства каталог и отдаётся из control plane: раскатки конфигурации
    // на узлы не требуется, следующая регистрация просто не проходит.
    expect((await askDirectory(account.username)).body).toContain('not found');
  });

  it('отключённый шлюз перестаёт регистрироваться немедленно', async () => {
    const partner = await createPartner();
    await verifyPartner(partner);
    const { id, account } = await createGateway(partner);
    await setGatewayStatus(id, 'active');
    expect((await askDirectory(account.username)).body).toContain('<user id=');

    expect((await setGatewayStatus(id, 'suspended')).statusCode).toBe(201);
    expect((await askDirectory(account.username)).body).toContain('not found');

    // Источник записан: такое отключение партнёр не снимает (ADR-0047).
    const listed = await api().inject({
      method: 'GET',
      url: `/gateways?partnerId=${partner}`,
      headers: auth(),
    });
    const suspended = listed
      .json<{ gateways: { id: string; suspended_by: string | null }[] }>()
      .gateways.find((row) => row.id === id);
    expect(suspended?.suspended_by).toBe('admin');

    // Обратно — одним действием администратора: источник уходит вместе с отключением,
    // и следующая регистрация снова проходит.
    const restored = await setGatewayStatus(id, 'active');
    expect(restored.json<{ gateway: { suspended_by: string | null } }>().gateway.suspended_by).toBe(
      null,
    );
    expect((await askDirectory(account.username)).body).toContain('<user id=');
  });

  it('канал клиента получает переменные, по которым узнаётся при вызове', async () => {
    const client = await createClient();
    await activateClient(client);
    const created = await api().inject({
      method: 'POST',
      url: '/channels',
      headers: auth(),
      payload: {
        clientId: client,
        name: unique('Линия'),
        recordingRequired: true,
        callerId: '79001234567',
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ channel: { id: string }; account: SipAccount }>();

    await api().inject({
      method: 'POST',
      url: `/channels/${body.channel.id}/status`,
      headers: auth(),
      payload: { status: 'active' },
    });

    const response = await askDirectory(body.account.username);
    // На узле знания о каналах нет: канал опознаётся по переменной из каталога.
    expect(response.body).toContain(`value="${body.channel.id}"`);
    expect(response.body).toContain('zvonix_recording_required');
    expect(response.body).toContain('value="79001234567"');
  });

  it('неизвестное имя и отключённая запись отвечают одинаково', async () => {
    const partner = await createPartner();
    await verifyPartner(partner);
    const { account } = await createGateway(partner);

    const unknown = await askDirectory('gw-нетакого00');
    const disabled = await askDirectory(account.username);

    // Иначе по разнице ответов заблокированный партнёр узнаёт, что его шлюз
    // ещё числится в системе.
    expect(unknown.statusCode).toBe(disabled.statusCode);
    expect(unknown.body).toBe(disabled.body);
  });

  it('отметка о регистрации проставляется: видно, на каком узле шлюз', async () => {
    const partner = await createPartner();
    await verifyPartner(partner);
    const { id, account } = await createGateway(partner);
    await setGatewayStatus(id, 'active');
    await askDirectory(account.username);

    const listed = await api().inject({ method: 'GET', url: '/gateways', headers: auth() });
    const gateway = listed
      .json<{ gateways: { id: string; node_id: string | null; registered_at: string | null }[] }>()
      .gateways.find((g) => g.id === id);
    expect(gateway?.node_id).not.toBeNull();
    expect(gateway?.registered_at).not.toBeNull();
  });
});

describe('доступ к каталогу', () => {
  it('без ключа узла каталог не отдаётся', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/node/directory',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'section=directory&user=gw-aaaaaaaaaaaa',
    });
    expect(response.statusCode).toBe(401);
  });

  it('человеческая сессия каталог не открывает', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/node/directory',
      headers: { ...auth(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'section=directory&user=gw-aaaaaaaaaaaa',
    });
    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['не тот раздел', 'section=dialplan&user=gw-aaaaaaaaaaaa'],
    ['раздела нет вовсе', 'user=gw-aaaaaaaaaaaa'],
    ['тело пустое', ''],
    ['мусор вместо полей', 'что=то&совсем=другое'],
  ])('%s — это 200 и «записи нет», а не ошибка', async (_name, payload) => {
    // Любой код кроме 200 mod_xml_curl отбрасывает целиком и пишет ошибку в лог:
    // узел остаётся без учётных записей вообще. Поэтому ошибок здесь нет как класса.
    const response = await api().inject({
      method: 'POST',
      url: '/node/directory',
      headers: {
        authorization: `Basic ${Buffer.from(nodeKey, 'utf8').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('xml');
    expect(response.body).toContain('<result status="not found"/>');
  });
});

describe('правка настроек канала', () => {
  /** Заводит активный канал и возвращает его вместе с выданной учётной записью. */
  async function makeChannel(): Promise<{ id: string; account: SipAccount }> {
    const client = await createClient();
    await activateClient(client);

    const created = await api().inject({
      method: 'POST',
      url: '/channels',
      headers: auth(),
      payload: { clientId: client, name: unique('Линия'), recordingRequired: false },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ channel: { id: string }; account: SipAccount }>();

    await api().inject({
      method: 'POST',
      url: `/channels/${body.channel.id}/status`,
      headers: auth(),
      payload: { status: 'active' },
    });
    return { id: body.channel.id, account: body.account };
  }

  async function patch(id: string, payload: Record<string, unknown>) {
    return api().inject({ method: 'PATCH', url: `/channels/${id}`, headers: auth(), payload });
  }

  it('номер для показа меняется, а учётные данные остаются прежними', async () => {
    // Ради этого обработчик и заведён: раньше смена номера означала новый канал,
    // новый пароль SIP и перенастройку АТС у клиента.
    const channel = await makeChannel();

    const response = await patch(channel.id, { callerId: '79005554433' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ channel: { caller_id: string } }>().channel.caller_id).toBe(
      '79005554433',
    );

    // Регистрация не должна пострадать от косметической правки.
    expect((await askDirectory(channel.account.username)).body).toContain('<user id=');
  });

  it('требование записи меняется и видно узлу', async () => {
    // Переменная в каталоге есть всегда — меняется её значение, и именно его
    // читает диалплан, решая, писать ли разговор.
    const channel = await makeChannel();
    expect((await askDirectory(channel.account.username)).body).toContain(
      'name="zvonix_recording_required" value="false"',
    );

    expect((await patch(channel.id, { recordingRequired: true })).statusCode).toBe(200);
    expect((await askDirectory(channel.account.username)).body).toContain(
      'name="zvonix_recording_required" value="true"',
    );
  });

  it('непереданное поле не трогается, явный null очищает', async () => {
    // «Поля нет» и «поле равно null» — разные намерения, и путать их на номере
    // для показа значит однажды молча стереть настроенный номер.
    const channel = await makeChannel();
    expect((await patch(channel.id, { callerId: '79005554433' })).statusCode).toBe(200);

    const renamed = await patch(channel.id, { name: unique('Другая линия') });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ channel: { caller_id: string | null } }>().channel.caller_id).toBe(
      '79005554433',
    );

    const cleared = await patch(channel.id, { callerId: null });
    expect(cleared.json<{ channel: { caller_id: string | null } }>().channel.caller_id).toBeNull();
  });

  it('пустая правка — отказ, а не тихий успех', async () => {
    const channel = await makeChannel();
    expect((await patch(channel.id, {})).statusCode).toBe(400);
  });

  it('негодный номер для показа — отказ', async () => {
    const channel = await makeChannel();
    expect((await patch(channel.id, { callerId: 'не номер' })).statusCode).toBe(400);
  });

  it('несуществующий канал — 404', async () => {
    const response = await patch('01890a5d-ac96-774b-bcce-b302099a8057', { name: 'Линия' });
    expect(response.statusCode).toBe(404);
  });

  it('правка попадает в журнал целиком', async () => {
    const channel = await makeChannel();
    expect((await patch(channel.id, { callerId: '79005554433' })).statusCode).toBe(200);

    const response = await api().inject({
      method: 'GET',
      url: `/audit?action=channel.updated&entityId=${channel.id}`,
      headers: auth(),
    });
    const entries = response.json<{
      entries: { before: { caller_id: string | null }; after: { caller_id: string | null } }[];
    }>().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.before.caller_id).toBeNull();
    expect(entries[0]?.after.caller_id).toBe('79005554433');
  });
});
