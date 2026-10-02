/**
 * Файлы записей на диске площадки: подписанные ссылки, приём потоком, выдача с `Range`
 * ([ADR-0063](../../../../../docs/adr/0063-hranilishche-zapisey-na-diske.md)).
 *
 * Идёт через настоящее приложение и настоящий каталог: подпись, потоковый приём и
 * частичная выдача ломаются на стыке с Fastify, а не внутри одной функции.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareEnvironment, resetDatabase, startApi } from '../../testing/harness.js';
import { recordingObjectKey } from './object-storage.js';

let directory = '';
prepareEnvironment({ RECORDINGS_STORAGE: 'local' });

let app: NestFastifyApplication | undefined;

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

async function storage() {
  const { LocalObjectStorage } = await import('./local-storage.js');
  return api().get(LocalObjectStorage);
}

/** Ссылка → путь и запрос внутри приложения: префикс `/api` отрезает прокси. */
const inside = (link: string): string => {
  const url = new URL(link);
  return `${url.pathname.replace(/^\/api/u, '')}${url.search}`;
};

const WAV = Buffer.from('RIFF....WAVEfmt ' + 'x'.repeat(100), 'latin1');
const newKey = (): string =>
  recordingObjectKey(crypto.randomUUID(), new Date('2026-10-02T10:00:00Z'));

async function put(link: string, body: Buffer = WAV) {
  return api().inject({
    method: 'PUT',
    url: inside(link),
    headers: { 'content-type': 'audio/wav' },
    payload: body,
  });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'zvonix-recordings-'));
  process.env['RECORDINGS_DIR'] = directory;
  await resetDatabase();
  app = await startApi();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

describe('приём и выдача по ссылке', () => {
  it('файл ложится по ссылке на выгрузку и отдаётся по ссылке на прослушивание', async () => {
    const files = await storage();
    const key = newKey();

    const uploaded = await put(await files.presignUpload(key, 600));
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json<{ size_bytes: number }>().size_bytes).toBe(WAV.length);

    const heard = await api().inject({
      method: 'GET',
      url: inside(await files.presignDownload(key, 900)),
    });
    expect(heard.statusCode).toBe(200);
    expect(heard.headers['content-type']).toContain('audio/wav');
    expect(heard.headers['accept-ranges']).toBe('bytes');
    // Разговор — персональные данные: никаких кэшей по дороге.
    expect(heard.headers['cache-control']).toBe('private, no-store');
    expect(heard.rawPayload.equals(WAV)).toBe(true);
  });

  it('отдаёт часть файла по Range — без этого плеер не перематывает', async () => {
    const files = await storage();
    const key = newKey();
    await put(await files.presignUpload(key, 600));
    const link = inside(await files.presignDownload(key, 900));

    const head = await api().inject({ method: 'GET', url: link, headers: { range: 'bytes=0-9' } });
    expect(head.statusCode).toBe(206);
    expect(head.headers['content-range']).toBe(`bytes 0-9/${String(WAV.length)}`);
    expect(head.rawPayload.equals(WAV.subarray(0, 10))).toBe(true);

    const tail = await api().inject({ method: 'GET', url: link, headers: { range: 'bytes=-4' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(WAV.subarray(WAV.length - 4))).toBe(true);

    const beyond = await api().inject({
      method: 'GET',
      url: link,
      headers: { range: `bytes=${String(WAV.length + 5)}-` },
    });
    // Невыполнимый диапазон игнорируется: файл отдаётся целиком, воспроизведение не рвётся.
    expect(beyond.statusCode).toBe(200);
    expect(beyond.rawPayload.equals(WAV)).toBe(true);
  });

  it('принимает файл крупнее предела обычного тела запроса: запись идёт потоком', async () => {
    const files = await storage();
    const key = newKey();
    const big = Buffer.alloc(3 * 1024 * 1024, 7);

    const uploaded = await put(await files.presignUpload(key, 600), big);
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json<{ size_bytes: number }>().size_bytes).toBe(big.length);

    const heard = await api().inject({
      method: 'GET',
      url: inside(await files.presignDownload(key, 900)),
    });
    expect(heard.rawPayload.equals(big)).toBe(true);
  });

  it('пустой файл не принимается за запись', async () => {
    const files = await storage();
    const key = newKey();
    const response = await put(await files.presignUpload(key, 600), Buffer.alloc(0));
    expect(response.statusCode).toBe(400);
    expect(existsSync(join(directory, key))).toBe(false);
  });

  it('повторная выгрузка по той же ссылке заменяет файл целиком', async () => {
    const files = await storage();
    const key = newKey();
    const link = await files.presignUpload(key, 600);
    await put(link, Buffer.from('первый'));
    await put(link, Buffer.from('второй'));

    const heard = await api().inject({
      method: 'GET',
      url: inside(await files.presignDownload(key, 900)),
    });
    expect(heard.rawPayload.toString()).toBe('второй');
  });
});

describe('подпись ссылки', () => {
  it('ссылка на прослушивание не годится для выгрузки и наоборот', async () => {
    const files = await storage();
    const key = newKey();
    const upload = await files.presignUpload(key, 600);
    const download = await files.presignDownload(key, 900);

    // Подмена операции в адресе при прежней подписи.
    const asPut = download.replace('op=get', 'op=put');
    expect((await put(asPut)).statusCode).toBe(403);
    const asGet = upload.replace('op=put', 'op=get');
    expect((await api().inject({ method: 'GET', url: inside(asGet) })).statusCode).toBe(403);
  });

  it('чужой ключ с подписью другого объекта не открывается', async () => {
    const files = await storage();
    const mine = newKey();
    const foreign = newKey();
    await put(await files.presignUpload(foreign, 600));

    const link = await files.presignDownload(mine, 900);
    const swapped = link.replace(encodeURIComponent(mine), encodeURIComponent(foreign));
    expect((await api().inject({ method: 'GET', url: inside(swapped) })).statusCode).toBe(403);
  });

  it('истёкшая и испорченная подписи отвергаются раньше, чем что-то читается с диска', async () => {
    const files = await storage();
    const key = newKey();
    await put(await files.presignUpload(key, 600));

    const expired = await files.presignDownload(key, -5);
    expect((await api().inject({ method: 'GET', url: inside(expired) })).statusCode).toBe(403);

    const forged = (await files.presignDownload(key, 900)).replace(/sig=[^&]+/u, 'sig=AAAA');
    expect((await api().inject({ method: 'GET', url: inside(forged) })).statusCode).toBe(403);

    // Ни подписи, ни параметров: тот же отказ, а не «нет такого файла».
    const bare = await api().inject({ method: 'GET', url: '/storage/recordings' });
    expect(bare.statusCode).toBe(403);
  });

  it('ссылку на ключ чужого вида не выдать вовсе: выхода из каталога нет', async () => {
    const files = await storage();
    await expect(files.presignDownload('recordings/../../etc/passwd', 900)).rejects.toThrow();
    await expect(files.presignUpload('/etc/passwd', 600)).rejects.toThrow();
  });
});

describe('удаление', () => {
  it('убирает файл, а отсутствующий не считает ошибкой', async () => {
    const files = await storage();
    const key = newKey();
    await put(await files.presignUpload(key, 600));
    expect(existsSync(join(directory, key))).toBe(true);

    await files.remove(key);
    expect(existsSync(join(directory, key))).toBe(false);
    await expect(files.remove(key)).resolves.toBeUndefined();
  });
});
