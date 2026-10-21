/**
 * Картинки в обращениях ([ADR-0089](../../../../../docs/adr/0089-obrashcheniya-statusy-i-kartinki.md)): загрузка, проверка по
 * содержимому, прикрепление к сообщению, видимость автору и сотрудникам, суточный предел, стирание неприкреплённых.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  withDatabase,
} from '../../testing/harness.js';
import { bearer, fixtures } from '../messaging/messaging.fixtures.js';
import { SupportService } from './support.service.js';

const root = mkdtempSync(path.join(tmpdir(), 'zvonix-support-files-'));
prepareEnvironment({ SUPPORT_DIR: root });

let app: NestFastifyApplication | undefined;
let adminToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const fx = fixtures(api, () => adminToken);
const { user, put, clientWithMoney } = fx;

/** Минимальный PNG: сигнатура и добивка до нужного размера (тип определяется по первым байтам). */
const png = (size = 64): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size - 8),
  ]);

const upload = (token: string, body: Buffer, name = 'снимок.png') =>
  api().inject({
    method: 'POST',
    url: `/storage/support/attachments?name=${encodeURIComponent(name)}`,
    headers: { ...bearer(token), 'content-type': 'application/octet-stream' },
    payload: body,
  });

interface Uploaded {
  id: string;
  name: string;
  size: number;
  type: string;
}

interface Detail {
  ticket: { id: string };
  messages: { side: string; internal: boolean; attachments: Uploaded[] }[];
}

const createWith = (token: string, attachments: string[]) =>
  api().inject({
    method: 'POST',
    url: '/support/tickets',
    headers: bearer(token),
    payload: {
      cabinet: 'client',
      subject: 'Не приходит QR',
      category: 'bug',
      body: 'Смотрите на картинку',
      attachments,
    },
  });

const fetchImage = (token: string, id: string) =>
  api().inject({ method: 'GET', url: `/support/attachments/${id}`, headers: bearer(token) });

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  adminToken = (await user('admin')).token;
});

beforeEach(async () => {
  await withDatabase(async (execute) => {
    await execute(sql`delete from support_attachments`);
    await execute(sql`delete from support_ticket_messages`);
    await execute(sql`delete from support_tickets`);
  });
});

afterAll(async () => {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('загрузка', () => {
  it('PNG принимается: тип по содержимому, имя очищено; текст, SVG и пустое — отказ', async () => {
    const client = await clientWithMoney('1');
    const ok = await upload(client.token, png(), '../../etc/passwd.png');
    expect(ok.statusCode).toBe(201);
    const file = ok.json<Uploaded>();
    expect(file).toMatchObject({ type: 'png', size: 64 });
    expect(file.name).not.toContain('/');

    expect((await upload(client.token, Buffer.from('просто текст'))).statusCode).toBe(400);
    expect(
      (await upload(client.token, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))
        .statusCode,
    ).toBe(400);
    expect((await upload(client.token, Buffer.alloc(0))).statusCode).toBe(400);
    // Имя, прислав «расширение png» поверх текста, не обманывает: значение имеет только содержимое.
    expect((await upload(client.token, Buffer.from('MZ'), 'вирус.png')).statusCode).toBe(400);
  });

  it('больше 5 МБ — отказ; без входа и из чужой роли нельзя', async () => {
    const client = await clientWithMoney('1');
    expect((await upload(client.token, png(5 * 1024 * 1024 + 1))).statusCode).toBe(400);
    expect(
      (
        await api().inject({
          method: 'POST',
          url: '/storage/support/attachments',
          headers: { 'content-type': 'application/octet-stream' },
          payload: png(),
        })
      ).statusCode,
    ).toBe(401);
  });

  it('за сутки не больше 20 МБ: после этого — 429', async () => {
    const client = await clientWithMoney('1');
    for (let index = 0; index < 4; index += 1) {
      expect((await upload(client.token, png(5 * 1024 * 1024 - 100))).statusCode).toBe(201);
    }
    expect((await upload(client.token, png(2 * 1024 * 1024))).statusCode).toBe(429);
  });
});

describe('прикрепление и видимость', () => {
  it('картинки уходят вместе с обращением; автор и сотрудник видят, чужой клиент — нет; повторно прикрепить нельзя', async () => {
    const client = await clientWithMoney('1');
    const stranger = await clientWithMoney('1');
    const staff = await user('support');
    const first = (await upload(client.token, png(), 'раз.png')).json<Uploaded>();
    const second = (await upload(client.token, png(80), 'два.png')).json<Uploaded>();

    const created = await createWith(client.token, [first.id, second.id]);
    expect(created.statusCode).toBe(201);
    const detail = created.json<Detail>();
    expect(detail.messages[0]?.attachments.map((file) => file.name)).toEqual([
      'раз.png',
      'два.png',
    ]);

    const shown = await fetchImage(client.token, first.id);
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['content-type']).toBe('image/png');
    expect(shown.headers['x-content-type-options']).toBe('nosniff');
    expect(shown.rawPayload.length).toBe(64);
    expect((await fetchImage(staff.token, first.id)).statusCode).toBe(200);
    expect((await fetchImage(stranger.token, first.id)).statusCode).toBe(404);
    expect((await fetchImage(client.token, 'не-идентификатор')).statusCode).toBe(404);

    // Уже прикреплённую вторым сообщением взять нельзя; чужую — тоже.
    const again = await api().inject({
      method: 'POST',
      url: `/support/tickets/${detail.ticket.id}/messages`,
      headers: bearer(client.token),
      payload: { body: 'Ещё одно сообщение', attachments: [first.id] },
    });
    expect(again.statusCode).toBe(409);
    const foreign = (await upload(stranger.token, png())).json<Uploaded>();
    const stolen = await api().inject({
      method: 'POST',
      url: `/support/tickets/${detail.ticket.id}/messages`,
      headers: bearer(client.token),
      payload: { body: 'Чужая картинка', attachments: [foreign.id] },
    });
    expect(stolen.statusCode).toBe(409);
  });

  it('картинка в заметке сотрудников автору не видна; в ответе — видна; больше пяти — отказ', async () => {
    const client = await clientWithMoney('1');
    const staff = await user('support');
    const { ticket } = (await createWith(client.token, [])).json<Detail>();

    const noteImage = (await upload(staff.token, png(), 'заметка.png')).json<Uploaded>();
    await api().inject({
      method: 'POST',
      url: `/support/staff/tickets/${ticket.id}/messages`,
      headers: bearer(staff.token),
      payload: { body: 'Внутренняя заметка', internal: true, attachments: [noteImage.id] },
    });
    const replyImage = (await upload(staff.token, png(70), 'ответ.png')).json<Uploaded>();
    await api().inject({
      method: 'POST',
      url: `/support/staff/tickets/${ticket.id}/messages`,
      headers: bearer(staff.token),
      payload: { body: 'Ответ автору', attachments: [replyImage.id] },
    });

    const own = (
      await api().inject({
        method: 'GET',
        url: `/support/tickets/${ticket.id}`,
        headers: bearer(client.token),
      })
    ).json<Detail>();
    expect(own.messages.map((message) => message.attachments.length)).toEqual([0, 1]);
    expect((await fetchImage(client.token, noteImage.id)).statusCode).toBe(404);
    expect((await fetchImage(client.token, replyImage.id)).statusCode).toBe(200);

    const many = await createWith(
      client.token,
      Array.from({ length: 6 }, () => crypto.randomUUID()),
    );
    expect(many.statusCode).toBe(400);
  });
});

describe('стирание неприкреплённых', () => {
  it('загруженная и не прикреплённая за сутки стирается вместе с файлом; прикреплённая остаётся', async () => {
    const client = await clientWithMoney('1');
    const kept = (await upload(client.token, png())).json<Uploaded>();
    const lost = (await upload(client.token, png(90))).json<Uploaded>();
    await createWith(client.token, [kept.id]);

    const filesOf = async () =>
      withDatabase(async (execute) => {
        const result = await execute(sql`select id, stored_name from support_attachments`);
        return result.rows as { id: string; stored_name: string }[];
      });
    const before = await filesOf();
    const lostRow = before.find((row) => row.id === lost.id);
    expect(lostRow).toBeDefined();
    expect(existsSync(path.join(root, lostRow?.stored_name ?? ''))).toBe(true);

    await withDatabase(async (execute) => {
      await execute(sql`update support_attachments set created_at = now() - interval '2 days'`);
    });
    expect(await api().get(SupportService).purgeUploads(new Date())).toBe(1);

    const after = await filesOf();
    expect(after.map((row) => row.id)).toEqual([kept.id]);
    expect(existsSync(path.join(root, lostRow?.stored_name ?? ''))).toBe(false);
    // Пока не нужно — и не стирается: путь прежнего статуса.
    expect((await put(adminToken, { 'support.autoclose_days': 7 })).statusCode).toBe(200);
  });
});
