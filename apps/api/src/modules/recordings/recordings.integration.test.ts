/**
 * Записи разговоров на реальной базе.
 *
 * Хранилище подставное, но подставлен **сервер**, а не класс: подписание ссылок в S3
 * выполняется локально и сети не требует, поэтому настоящий клиент проверяется как есть —
 * вместе с адресацией путём, учётными данными и подписью. Наружу проверки при этом
 * не ходят (ADR-0006).
 *
 * Проверяется то, что стоит дорого при ошибке: узел не выгружает чужие записи,
 * клиент не слушает чужие разговоры, каждое обращение попадает в журнал аудита,
 * а по истечении срока хранения объект удаляется раньше отметки в базе.
 */

import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
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

/**
 * Подставной сервер S3.
 *
 * Отвечает на удаление объекта и запоминает, что у него просили. Умеет ломаться —
 * это нужно, чтобы проверить порядок: объект удаляется раньше отметки в базе.
 */
/** Ключи, удаление которых запрашивал клиент S3. */
const removedKeys: string[] = [];
let failRemoval = false;
let storageServer: Server | undefined;

const STORAGE_PORT = 45_733;
prepareEnvironment({
  S3_ENDPOINT: `http://127.0.0.1:${String(STORAGE_PORT)}`,
  S3_ACCESS_KEY: 'proverka',
  S3_SECRET_KEY: 'proverka-secret',
  S3_BUCKET: 'zvonix-test',
});

let app: NestFastifyApplication | undefined;
let adminToken = '';
let nodeKey = '';
let nodeId = '';
let otherNodeKey = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const auth = (token = adminToken) => ({ authorization: `Bearer ${token}` });
const asNode = (key = nodeKey) => ({ authorization: `Bearer ${key}` });

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
};

let msisdnCounter = 0;
const nextMsisdn = (): string => {
  msisdnCounter += 1;
  return `79${String(400000000 + msisdnCounter).slice(0, 9)}`;
};

async function post(url: string, payload: Record<string, unknown>, headers = auth()) {
  return api().inject({ method: 'POST', url, headers, payload });
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

async function loginAs(role: 'client' | 'support'): Promise<{ userId: string; token: string }> {
  const { IdentityService } = await import('../identity/identity.service.js');
  const email = uniqueEmail();
  const created = await api().get(IdentityService).createByAdmin({
    email,
    password: TEST_PASSWORD,
    fullName: 'Человек',
    role,
    status: 'active',
  });
  const login = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return { userId: created.id, token: login.json<{ token: string }>().token };
}

/** Заводит вызов на указанном узле: запись всегда принадлежит вызову. */
async function makeCall(options: { node?: string; ownerUserId?: string } = {}) {
  const ownerUserId = options.ownerUserId ?? (await createUser('client'));
  const client = (await post('/clients', { ownerUserId, name: unique('Такси') })).json<{
    client: { id: string };
  }>().client.id;

  const channel = (
    await post('/channels', { clientId: client, name: unique('Линия'), recordingRequired: true })
  ).json<{ channel: { id: string } }>().channel.id;

  const callId = crypto.randomUUID();
  await withDatabase(async (execute) => {
    await execute(sql`
      insert into calls (id, external_id, channel_id, node_id, destination, status)
      values (${callId}::uuid, ${unique('uuid')}, ${channel}::uuid, ${options.node ?? nodeId}::uuid,
              ${nextMsisdn()}, 'completed')
    `);
  });

  return { callId, client, channel, ownerUserId };
}

/** Проводит запись до подтверждённой выгрузки. */
async function uploadedRecording(options: { ownerUserId?: string } = {}) {
  const call = await makeCall(options);
  const prepared = await post('/node/recordings/upload-url', { callId: call.callId }, asNode());
  expect(prepared.statusCode).toBe(200);

  const confirmed = await post(
    '/node/recordings/uploaded',
    { callId: call.callId, durationSeconds: 61, sizeBytes: 512_000 },
    asNode(),
  );
  expect(confirmed.statusCode).toBe(200);

  return { ...call, recordingId: confirmed.json<{ recording_id: string }>().recording_id };
}

async function enrollNode(): Promise<{ id: string; key: string }> {
  const provisioned = await post('/nodes', { name: unique('Узел') });
  const id = provisioned.json<{ node: { id: string } }>().node.id;
  const command = provisioned.json<{ install: { command: string } }>().install.command;

  const enrolled = await api().inject({
    method: 'POST',
    url: '/node/enroll',
    headers: { authorization: `Bearer ${command.slice(command.lastIndexOf(' ') + 1)}` },
    payload: { hostname: unique('node'), agentVersion: '1.0.0' },
  });
  const key = enrolled.json<{ key: { key_id: string; secret: string } }>().key;
  return { id, key: `${key.key_id}.${key.secret}` };
}

beforeAll(async () => {
  storageServer = createServer((request, response) => {
    if (failRemoval) {
      response.writeHead(503).end();
      return;
    }
    if (request.method === 'DELETE' && request.url !== undefined) {
      // Клиент дописывает `?x-id=DeleteObject`: ключ объекта — это путь без строки запроса.
      const [path = ''] = request.url.split('?');
      removedKeys.push(decodeURIComponent(path.replace('/zvonix-test/', '')));
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200).end();
  });
  storageServer.listen(STORAGE_PORT, '127.0.0.1');
  await once(storageServer, 'listening');

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
  adminToken = (
    await api().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
    })
  ).json<{ token: string }>().token;

  const own = await enrollNode();
  nodeId = own.id;
  nodeKey = own.key;
  otherNodeKey = (await enrollNode()).key;
});

afterAll(async () => {
  await app?.close();
  storageServer?.close();
});

describe('выгрузка узлом', () => {
  it('узел получает ссылку на объект, но не ключи хранилища', async () => {
    const call = await makeCall();
    const response = await post('/node/recordings/upload-url', { callId: call.callId }, asNode());
    expect(response.statusCode).toBe(200);

    const body = response.json<{ upload_url: string; object_key: string }>();
    // Ключ объекта задаёт control plane: узел его не выбирает и чужой прислать не может.
    expect(body.object_key).toMatch(/^recordings\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.wav$/);
    expect(body.upload_url).toContain(body.object_key);
    // Ни ключа доступа, ни секрета хранилища в ответе быть не должно.
    expect(response.body).not.toContain('S3_');
    expect(response.body).not.toContain('minioadmin');
  });

  it('чужой вызов узлу не отдаётся', async () => {
    const call = await makeCall();
    // Ссылку просит другой узел: иначе один узел получал бы запись, сделанную другим.
    const response = await post(
      '/node/recordings/upload-url',
      { callId: call.callId },
      asNode(otherNodeKey),
    );
    expect(response.statusCode).toBe(403);
  });

  it('повтор даёт ту же запись с новой ссылкой, а не вторую запись', async () => {
    const call = await makeCall();
    const first = await post('/node/recordings/upload-url', { callId: call.callId }, asNode());
    const again = await post('/node/recordings/upload-url', { callId: call.callId }, asNode());

    // Первая попытка выгрузки могла не дойти — это штатный режим.
    expect(again.json<{ object_key: string }>().object_key).toBe(
      first.json<{ object_key: string }>().object_key,
    );

    const count = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as n from recordings where call_id = ${call.callId}`,
      );
      return (result.rows[0] as { n: number }).n;
    });
    expect(count).toBe(1);
  });

  it('до подтверждения запись не отдаётся: файл мог не доехать', async () => {
    const call = await makeCall();
    await post('/node/recordings/upload-url', { callId: call.callId }, asNode());

    const found = await api().inject({
      method: 'GET',
      url: `/recordings/by-call/${call.callId}`,
      headers: auth(),
    });
    const recording = found.json<{ recording: { id: string; uploaded_at: string | null } }>()
      .recording;
    expect(recording.uploaded_at).toBeNull();

    const link = await api().inject({
      method: 'POST',
      url: `/recordings/${recording.id}/link`,
      headers: auth(),
    });
    expect(link.statusCode).toBe(409);
  });

  it('пустой файл не принимается за состоявшуюся запись', async () => {
    const call = await makeCall();
    await post('/node/recordings/upload-url', { callId: call.callId }, asNode());
    const response = await post(
      '/node/recordings/uploaded',
      { callId: call.callId, durationSeconds: 10, sizeBytes: 0 },
      asNode(),
    );
    expect(response.statusCode).toBe(400);
  });

  it('повторное подтверждение не переписывает момент первого', async () => {
    const recording = await uploadedRecording();
    const first = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select uploaded_at from recordings where id = ${recording.recordingId}`,
      );
      return (result.rows[0] as { uploaded_at: string }).uploaded_at;
    });

    await post(
      '/node/recordings/uploaded',
      { callId: recording.callId, durationSeconds: 99, sizeBytes: 999 },
      asNode(),
    );

    // По моменту первой выгрузки считается, сколько запись уже хранится.
    const after = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select uploaded_at from recordings where id = ${recording.recordingId}`,
      );
      return (result.rows[0] as { uploaded_at: string }).uploaded_at;
    });
    expect(after).toBe(first);
  });
});

describe('выдача человеку', () => {
  it('администратор получает подписанную ссылку, и это попадает в журнал', async () => {
    const recording = await uploadedRecording();
    const response = await api().inject({
      method: 'POST',
      url: `/recordings/${recording.recordingId}/link`,
      headers: auth(),
    });
    expect(response.statusCode).toBe(201);
    // Ссылка настоящая: подписана реальным клиентом S3 и содержит подпись.
    const url = response.json<{ url: string }>().url;
    expect(url).toContain('X-Amz-Signature');
    expect(url).toContain('zvonix-test');

    const audited = await withDatabase(async (execute) => {
      const result = await execute(sql`
        select after::text as after from audit_log
         where action = 'recording.link_issued' and entity_id = ${recording.recordingId}
      `);
      return result.rows[0] as { after: string } | undefined;
    });
    // Единственный след того, кто получил доступ к разговору.
    expect(audited).toBeDefined();
    // Сама ссылка в журнал не пишется: она даёт доступ, а журнал читают шире.
    expect(audited?.after).not.toContain('X-Amz-Signature');
  });

  it('клиент слушает только свои вызовы', async () => {
    const person = await loginAs('client');
    const mine = await uploadedRecording({ ownerUserId: person.userId });
    const foreign = await uploadedRecording();

    const own = await api().inject({
      method: 'POST',
      url: `/recordings/${mine.recordingId}/link`,
      headers: auth(person.token),
    });
    expect(own.statusCode).toBe(201);

    const other = await api().inject({
      method: 'POST',
      url: `/recordings/${foreign.recordingId}/link`,
      headers: auth(person.token),
    });
    // `404`, а не `403`: иначе по разнице ответов проверяется существование чужих записей.
    expect(other.statusCode).toBe(404);
  });

  it('партнёр записи не получает', async () => {
    const recording = await uploadedRecording();
    const { IdentityService } = await import('../identity/identity.service.js');
    const email = uniqueEmail();
    await api().get(IdentityService).createByAdmin({
      email,
      password: TEST_PASSWORD,
      fullName: 'Партнёр',
      role: 'partner',
      status: 'active',
    });
    const token = (
      await api().inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: TEST_PASSWORD },
      })
    ).json<{ token: string }>().token;

    // Отдавать партнёру разговор пассажира — передача персональных данных
    // третьему лицу. Решение вынесено в TASKS.md.
    const response = await api().inject({
      method: 'POST',
      url: `/recordings/${recording.recordingId}/link`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(403);
  });

  it('поддержка получает ссылку', async () => {
    const person = await loginAs('support');
    const recording = await uploadedRecording();
    const response = await api().inject({
      method: 'POST',
      url: `/recordings/${recording.recordingId}/link`,
      headers: auth(person.token),
    });
    expect(response.statusCode).toBe(201);
  });

  it('без входа ссылку не получить', async () => {
    const recording = await uploadedRecording();
    const response = await api().inject({
      method: 'POST',
      url: `/recordings/${recording.recordingId}/link`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('срок хранения', () => {
  it('по истечении объект удаляется, а строка остаётся', async () => {
    const recording = await uploadedRecording();
    await withDatabase(async (execute) => {
      await execute(
        sql`update recordings set expires_at = now() - interval '1 day' where id = ${recording.recordingId}`,
      );
    });

    const { RecordingsService } = await import('./recordings.service.js');
    const removed = await api().get(RecordingsService).removeExpired();
    expect(removed).toBeGreaterThanOrEqual(1);

    const stored = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select object_key, deleted_at from recordings where id = ${recording.recordingId}`,
      );
      return result.rows[0] as { object_key: string; deleted_at: string | null };
    });
    // Строка остаётся: по ней видно, что запись была и ушла по сроку.
    expect(stored.deleted_at).not.toBeNull();
    expect(removedKeys).toContain(stored.object_key);

    // Удалённую не отдаём.
    const link = await api().inject({
      method: 'POST',
      url: `/recordings/${recording.recordingId}/link`,
      headers: auth(),
    });
    expect(link.statusCode).toBe(404);
  });

  it('недоступное хранилище не даёт пометить запись удалённой', async () => {
    const recording = await uploadedRecording();
    await withDatabase(async (execute) => {
      await execute(
        sql`update recordings set expires_at = now() - interval '1 day' where id = ${recording.recordingId}`,
      );
    });

    failRemoval = true;
    const { RecordingsService } = await import('./recordings.service.js');
    const removed = await api().get(RecordingsService).removeExpired();
    failRemoval = false;

    expect(removed).toBe(0);
    const stored = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select deleted_at from recordings where id = ${recording.recordingId}`,
      );
      return (result.rows[0] as { deleted_at: string | null }).deleted_at;
    });
    // Обратный порядок оставил бы запись помеченной удалённой, а файл — на месте:
    // разговор продолжал бы храниться, и никто бы об этом не знал.
    expect(stored).toBeNull();
  });
});
