import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Config, Logger } from '../../infra/tokens.js';
import { LocalObjectStorage } from './local-storage.js';

const logger = (): Logger => {
  const stub = {
    child: () => stub,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return stub;
};

const storageIn = (directory: string, log: Logger = logger()) =>
  new LocalObjectStorage(
    {
      RECORDINGS_DIR: directory,
      WEB_BASE_URL: 'https://cp.example.test',
      SECRET_KEY: 'k'.repeat(40),
    } as unknown as Config,
    log,
  );

describe('каталог записей принимает запись (2026-10-04)', () => {
  it('рабочий каталог — проверка проходит и не оставляет следов', async () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'zvonix-rec-')), 'новый', 'каталог');
    expect(await storageIn(directory).checkWritable()).toBeUndefined();
  });

  it('каталог, в который войти нельзя, — причина названа, а старт не падает', async () => {
    // Путь «внутри файла»: создать каталог нельзя, как нельзя было войти в чужой каталог.
    const file = join(mkdtempSync(join(tmpdir(), 'zvonix-rec-')), 'занято');
    writeFileSync(file, 'x');
    const log = logger();
    const storage = storageIn(join(file, 'записи'), log);

    expect(await storage.checkWritable()).toBeInstanceOf(Error);
    await expect(storage.onModuleInit()).resolves.toBeUndefined();
  });
});
