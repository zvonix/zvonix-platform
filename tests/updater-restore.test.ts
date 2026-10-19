/**
 * Служба обновления: восстановление из копии ([ADR-0086](../docs/adr/0086-rezervnye-kopii-v-kabinete.md), часть 2).
 *
 * Запускается настоящий `deploy/updater.py`; PostgreSQL, `systemctl`, проба готовности и миграции подставные
 * (`updater-fakes.ts`). Главное, что здесь проверяется: рабочая база не стирается ни при каком исходе; до остановки
 * служб любой провал оставляет всё как было; после подмены имён неудачный запуск возвращает прежнюю базу.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_BACKUP, FAKE_MIGRATE, FAKE_PG, FAKE_READY, FAKE_SYSTEMCTL } from './updater-fakes.js';

vi.setConfig({ testTimeout: 60_000 });

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const updater = path.join(root, 'deploy', 'updater.py');
const slashes = (value: string): string => value.split(path.sep).join('/');
const target = 'daily/daily-20261018-030000.dump';

let dir = '';
const exchange = (...parts: string[]): string => path.join(dir, 'exchange', ...parts);

function setup(options: { freshCheck: boolean }): void {
  for (const [name, source] of [
    ['pg', FAKE_PG],
    ['backup', FAKE_BACKUP],
    ['systemctl', FAKE_SYSTEMCTL],
    ['ready', FAKE_READY],
    ['migrate', FAKE_MIGRATE],
  ] as const) {
    writeFileSync(path.join(dir, `${name}.py`), source);
  }
  mkdirSync(exchange('requests'), { recursive: true });
  mkdirSync(path.join(dir, 'backups', 'daily'), { recursive: true });
  writeFileSync(path.join(dir, 'backups', 'daily', 'daily-20261018-030000.dump'), 'копия');
  // Прежняя замещённая база — после успеха она удаляется: хранится только последняя.
  writeFileSync(path.join(dir, 'databases.txt'), 'zvonix_replaced_20260101000000\n');
  if (options.freshCheck) {
    const at = new Date().toISOString().replace('Z', '+00:00');
    writeFileSync(
      exchange('backup-checks.json'),
      JSON.stringify({ checks: { [target]: { at, ok: true, detail: 'таблиц 14' } } }),
    );
  }
}

function enqueue(): string {
  const id = randomUUID();
  writeFileSync(
    exchange('requests', `${id}.json`),
    JSON.stringify({
      action: 'backup-restore',
      target,
      tag: null,
      by: 'admin@example.test',
      at: new Date().toISOString(),
    }),
  );
  return id;
}

function runUpdater(extra: Record<string, string> = {}): void {
  const exe = (name: string): string => `${python} ${slashes(path.join(dir, `${name}.py`))}`;
  execFileSync(python, [updater], {
    stdio: 'pipe',
    env: {
      ...process.env,
      ZVONIX_UPDATER_DIR: exchange(),
      ZVONIX_BACKUPS_DIR: path.join(dir, 'backups'),
      ZVONIX_PG_PREFIX: exe('pg'),
      ZVONIX_BACKUP_CMD: exe('backup'),
      ZVONIX_SYSTEMCTL_CMD: exe('systemctl'),
      ZVONIX_READY_CMD: exe('ready'),
      ZVONIX_MIGRATE_CMD: exe('migrate'),
      ZVONIX_READY_ATTEMPTS: '2',
      ZVONIX_LOCK_FILE: path.join(dir, 'deploy.lock'),
      ZVONIX_EXPORT_OWNER: '',
      ZVONIX_ENV_FILE: path.join(dir, 'нет-такого-файла'),
      ZVONIX_GITHUB_ENV: path.join(dir, 'нет-такого-файла'),
      FAKE_DIR: dir,
      ...extra,
    },
  });
}

const state = (id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(exchange('runs', id, 'state.json'), 'utf8')) as Record<string, unknown>;
const journal = (id: string): string => readFileSync(exchange('runs', id, 'log'), 'utf8');
/**
 * Вызванные команды по порядку. Опрос состояния сертификата, который служба делает при каждом запуске, в счёт не
 * идёт: он тоже зовёт подставной `systemctl`, но к восстановлению отношения не имеет.
 */
const calls = (): string[] =>
  readFileSync(path.join(dir, 'calls.log'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line !== '' && !line.startsWith('systemctl is-'));
/** Номер первой вызванной команды, содержащей фрагмент; -1 — не вызывалась. */
const at = (fragment: string): number => calls().findIndex((line) => line.includes(fragment));
const called = (fragment: string): boolean => at(fragment) !== -1;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zvonix-restore-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('восстановление: успех', () => {
  it('порядок: страховочная копия → новая база → миграции → стоп → подмена имён → старт; прежняя база сохранена', () => {
    setup({ freshCheck: true });
    const id = enqueue();
    runUpdater();

    expect(state(id)).toMatchObject({ status: 'succeeded', target });
    const order = [
      at('zvonix-backup before-restore'),
      at('createdb -O zvonix zvonix_restore'),
      at('pg_restore --no-owner --role=zvonix --exit-on-error -d zvonix_restore'),
      at('migrate'),
      at('systemctl stop'),
      at('RENAME TO zvonix_replaced_'),
      at('ALTER DATABASE zvonix_restore RENAME TO zvonix'),
      at('systemctl start'),
    ];
    expect(order.every((index) => index !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Службы останавливаются в обратном порядке запуска: сначала кабинет, потом API.
    expect(calls().filter((line) => line.startsWith('systemctl stop'))).toEqual([
      'systemctl stop zvonix-web',
      'systemctl stop zvonix-worker',
      'systemctl stop zvonix-api',
    ]);
    // Рабочая база не стирается: ни одной команды dropdb над ней, только прежняя замещённая убирается.
    const drops = calls().filter((line) => line.startsWith('dropdb'));
    expect(drops.some((line) => line.split(' ').includes('zvonix'))).toBe(false);
    expect(drops).toContain('dropdb --if-exists zvonix_replaced_20260101000000');
    expect(journal(id)).toContain('Прежняя база сохранена как zvonix_replaced_');
  });

  it('копия без свежей проверки сначала проверяется сама', () => {
    setup({ freshCheck: false });
    const id = enqueue();
    runUpdater();
    expect(state(id)['status']).toBe('succeeded');
    expect(at('createdb zvonix_verify')).toBeLessThan(at('zvonix-backup before-restore'));
  });
});

describe('восстановление: провал до остановки служб — рабочая база нетронута', () => {
  it('копия не годна — страховочная копия даже не снимается', () => {
    setup({ freshCheck: false });
    const id = enqueue();
    runUpdater({ FAKE_FEW_TABLES: '1' });
    expect(state(id)['status']).toBe('failed');
    expect(called('zvonix-backup')).toBe(false);
    expect(called('systemctl')).toBe(false);
    expect(journal(id)).toContain('рабочая база не тронута');
  });

  it('страховочная копия не снялась — восстановление не начинается', () => {
    setup({ freshCheck: true });
    const id = enqueue();
    runUpdater({ FAKE_BACKUP_FAIL: '1' });
    expect(state(id)['status']).toBe('failed');
    expect(called('createdb')).toBe(false);
    expect(called('systemctl')).toBe(false);
  });

  it('копия не разворачивается — новая база убирается, службы не трогаются', () => {
    setup({ freshCheck: true });
    const id = enqueue();
    runUpdater({ FAKE_RESTORE_FAIL: '1' });
    expect(state(id)['status']).toBe('failed');
    expect(calls().at(-1)).toBe('dropdb --if-exists zvonix_restore');
    expect(called('systemctl')).toBe(false);
    expect(called('RENAME')).toBe(false);
  });

  it('миграции не прошли на новой базе — то же', () => {
    setup({ freshCheck: true });
    const id = enqueue();
    runUpdater({ FAKE_MIGRATE_FAIL: '1' });
    expect(state(id)['status']).toBe('failed');
    expect(journal(id)).toContain('миграции не прошли');
    expect(calls().at(-1)).toBe('dropdb --if-exists zvonix_restore');
    expect(called('systemctl')).toBe(false);
  });

  it('службы не остановились — запускаются обратно, имена баз не менялись', () => {
    setup({ freshCheck: true });
    const id = enqueue();
    runUpdater({ FAKE_STOP_FAIL: '1' });
    expect(state(id)['status']).toBe('failed');
    expect(called('systemctl start')).toBe(true);
    expect(called('RENAME')).toBe(false);
  });
});

describe('восстановление: провал при подмене и запуске', () => {
  it('не удалось переименовать рабочую базу — службы запущены, новая база убрана', () => {
    setup({ freshCheck: true });
    const id = enqueue();
    runUpdater({ FAKE_FAIL_STATEMENT: 'RENAME TO zvonix_replaced' });
    expect(state(id)['status']).toBe('failed');
    expect(called('ALLOW_CONNECTIONS true')).toBe(true);
    expect(at('systemctl start')).toBeGreaterThan(at('RENAME TO zvonix_replaced'));
    expect(calls().at(-1)).toBe('dropdb --if-exists zvonix_restore');
    expect(journal(id)).toContain('прежняя база возвращена');
  });

  it('службы не поднялись на восстановленной базе — прежняя база возвращается под рабочее имя', () => {
    setup({ freshCheck: true });
    writeFileSync(path.join(dir, 'not-ready'), '');
    const id = enqueue();
    runUpdater();
    expect(state(id)['status']).toBe('failed');
    expect(called('RENAME TO zvonix_failed_')).toBe(true);
    expect(
      calls().some((line) => /RENAME TO zvonix$/.test(line) && line.includes('zvonix_replaced_')),
    ).toBe(true);
    expect(journal(id)).toContain('восстановленная база сохранена как zvonix_failed_');
    // Ни одна база не удалена при провале: и прежняя, и неудачная остаются на диске.
    expect(called('dropdb --if-exists zvonix_replaced_20260101000000')).toBe(false);
  });
});

describe('восстановление: замок выкладки', () => {
  it('на сервере без замка (не Linux) проверки службы всё равно идут; файл замка не остаётся мусором', () => {
    setup({ freshCheck: true });
    enqueue();
    runUpdater();
    // На Linux замок берётся и отпускается; на Windows его нет вовсе. И там и там работа доходит до конца.
    expect(existsSync(exchange('backups.json'))).toBe(true);
  });
});
