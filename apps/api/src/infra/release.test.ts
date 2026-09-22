import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseRelease, readRelease } from './release.js';

describe('разбор RELEASE', () => {
  it('читает то, что пишет release-pack.mjs', () => {
    expect(
      parseRelease('v0.1.3\ncommit 196005da2974ba7c41d2\nbuilt 2026-09-22T12:00:00.000Z\n'),
    ).toEqual({
      version: 'v0.1.3',
      commit: '196005da2974ba7c41d2',
      builtAt: '2026-09-22T12:00:00.000Z',
    });
  });

  it('переводы строк Windows и лишние пробелы не входят в значения', () => {
    expect(parseRelease('v0.1.3\r\ncommit abc \r\nbuilt 2026-09-22T12:00:00Z\r\n')).toEqual({
      version: 'v0.1.3',
      commit: 'abc',
      builtAt: '2026-09-22T12:00:00Z',
    });
  });

  it('недостающее — null, а не пустая строка', () => {
    expect(parseRelease('v0.1.3\n')).toEqual({ version: 'v0.1.3', commit: null, builtAt: null });
    expect(parseRelease('')).toEqual({ version: null, commit: null, builtAt: null });
  });
});

describe('чтение RELEASE', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zvonix-release-'));
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('нет файла — версия неизвестна: это сборка не из выпуска', () => {
    expect(readRelease(path.join(directory, 'нет-такого'))).toEqual({
      version: null,
      commit: null,
      builtAt: null,
    });
  });

  it('файл есть — версия из него', () => {
    const file = path.join(directory, 'RELEASE');
    writeFileSync(file, 'v0.1.3\ncommit abc\nbuilt 2026-09-22T12:00:00Z\n');
    expect(readRelease(file).version).toBe('v0.1.3');
  });

  it('прочая ошибка чтения — сбой, а не «версия неизвестна»', () => {
    // Каталог вместо файла: EISDIR, а не ENOENT.
    expect(() => readRelease(directory)).toThrow();
  });
});
