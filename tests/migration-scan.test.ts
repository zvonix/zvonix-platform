/**
 * Разбор новых миграций перед установкой ([ADR-0086](../docs/adr/0086-rezervnye-kopii-v-kabinete.md), часть 3).
 *
 * Запускается настоящий `deploy/migration_scan.py` на временных каталогах: что считается «только добавляет», что —
 * «меняет данные», и что новыми считаются только файлы, которых нет у работающего выпуска.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const scanner = path.join(root, 'deploy', 'migration_scan.py');

let dir = '';

function scan(
  release: Record<string, string>,
  current: Record<string, string> | null,
): { code: number | null; out: string } {
  const releaseDir = path.join(dir, 'release');
  const currentDir = path.join(dir, 'current');
  mkdirSync(releaseDir, { recursive: true });
  for (const [name, sql] of Object.entries(release))
    writeFileSync(path.join(releaseDir, name), sql);
  if (current !== null) {
    mkdirSync(currentDir, { recursive: true });
    for (const [name, sql] of Object.entries(current))
      writeFileSync(path.join(currentDir, name), sql);
  }
  const done = spawnSync(python, [scanner, releaseDir, currentDir], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  return { code: done.status, out: done.stdout };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zvonix-scan-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OLD = { '0001_a.sql': 'CREATE TABLE "a" ("id" uuid);' };

describe('разбор миграций выпуска', () => {
  it('новые таблицы, поля и индексы — только добавляют', () => {
    const result = scan(
      {
        ...OLD,
        '0002_b.sql': [
          'CREATE TABLE "b" ("id" uuid PRIMARY KEY);',
          '--> statement-breakpoint',
          'ALTER TABLE "a" ADD COLUMN "note" text;',
          '--> statement-breakpoint',
          'CREATE INDEX "b_idx" ON "b" ("id");',
          '--> statement-breakpoint',
          'ALTER TABLE "a" DROP CONSTRAINT "a_check";',
          '--> statement-breakpoint',
          'DROP INDEX "old_idx";',
        ].join('\n'),
      },
      OLD,
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('новых миграций: 1');
  });

  it.each([
    ['удаление таблицы', 'DROP TABLE "a";'],
    ['удаление столбца', 'ALTER TABLE "a" DROP COLUMN "x";'],
    ['смена типа', 'ALTER TABLE "a" ALTER COLUMN "x" SET DATA TYPE bigint;'],
    ['смена типа (TYPE)', 'ALTER TABLE "a" ALTER COLUMN "x" TYPE bigint;'],
    ['переименование', 'ALTER TABLE "a" RENAME COLUMN "x" TO "y";'],
    ['очистка', 'TRUNCATE TABLE "a";'],
    ['удаление строк', 'DELETE FROM "a" WHERE "x" IS NULL;'],
    ['переписывание строк', 'UPDATE "a" SET "x" = 1;'],
    ['запрет пустых значений', 'ALTER TABLE "a" ALTER COLUMN "x" SET NOT NULL;'],
  ])('%s — нужно подтверждение', (_name, sql) => {
    const result = scan({ ...OLD, '0002_risky.sql': sql }, OLD);
    expect(result.code).toBe(3);
    expect(result.out).toContain('0002_risky.sql:');
  });

  it('опасное в старой, уже применённой миграции не мешает: новыми считаются только новые файлы', () => {
    const old = { '0001_a.sql': 'DROP TABLE "legacy";' };
    const result = scan({ ...old, '0002_b.sql': 'CREATE TABLE "b" ("id" uuid);' }, old);
    expect(result.code).toBe(0);
  });

  it('комментарии не считаются операторами', () => {
    const result = scan(
      {
        ...OLD,
        '0002_b.sql':
          '-- раньше тут был DROP TABLE "a" и DELETE FROM "a"\nCREATE TABLE "b" ("id" uuid);',
      },
      OLD,
    );
    expect(result.code).toBe(0);
  });

  it('первая установка (работающего выпуска нет): данных ещё нет, опасных нет', () => {
    const result = scan({ ...OLD, '0002_b.sql': 'DELETE FROM "a";' }, null);
    expect(result.code).toBe(0);
  });

  it('каталога миграций выпуска нет — это ошибка, а не «безопасно»', () => {
    const done = spawnSync(python, [scanner, path.join(dir, 'нет'), path.join(dir, 'тоже-нет')], {
      encoding: 'utf8',
    });
    expect(done.status).toBe(1);
  });
});
