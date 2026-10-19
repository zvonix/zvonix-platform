/**
 * Служба обновления: резервные копии ([ADR-0086](../docs/adr/0086-rezervnye-kopii-v-kabinete.md)).
 *
 * Запускается настоящий `deploy/updater.py`; команды PostgreSQL и `zvonix-backup` подставные (`updater-fakes.ts`). Проверяется то, что нельзя увидеть по коду: что копия называется только
 * существующим файлом из каталога копий, что временная база убирается и при провале, что выданный файл
 * исчезает через полчаса, а рабочая база не затрагивается ни одной командой.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_BACKUP, FAKE_PG } from './updater-fakes.js';

vi.setConfig({ testTimeout: 60_000 });

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const updater = path.join(root, 'deploy', 'updater.py');
const slashes = (value: string): string => value.split(path.sep).join('/');

let dir = '';

const exchange = (...parts: string[]): string => path.join(dir, 'exchange', ...parts);

function setup(): void {
  writeFileSync(path.join(dir, 'pg.py'), FAKE_PG);
  writeFileSync(path.join(dir, 'backup.py'), FAKE_BACKUP);
  mkdirSync(exchange('requests'), { recursive: true });
  const backups = path.join(dir, 'backups');
  for (const sub of ['daily', 'manual', 'before-restore'])
    mkdirSync(path.join(backups, sub), { recursive: true });
  writeFileSync(path.join(backups, 'daily', 'daily-20261018-030000.dump'), 'ежедневная');
  writeFileSync(path.join(backups, 'manual', 'manual-20261017-100000.dump'), 'ручная');
  writeFileSync(path.join(backups, 'v0.1.125-20261018120000.dump'), 'перед обновлением');
  // Не копия: чужие файлы в каталоге в список не попадают.
  writeFileSync(path.join(backups, 'daily', 'notes.txt'), 'x');
}

function enqueue(request: Record<string, unknown>): string {
  const id = randomUUID();
  writeFileSync(
    exchange('requests', `${id}.json`),
    JSON.stringify({
      tag: null,
      by: 'admin@example.test',
      at: new Date().toISOString(),
      ...request,
    }),
  );
  return id;
}

function runUpdater(extra: Record<string, string> = {}): void {
  execFileSync(python, [updater], {
    stdio: 'pipe',
    env: {
      ...process.env,
      ZVONIX_UPDATER_DIR: exchange(),
      ZVONIX_BACKUPS_DIR: path.join(dir, 'backups'),
      ZVONIX_PG_PREFIX: `${python} ${slashes(path.join(dir, 'pg.py'))}`,
      ZVONIX_BACKUP_CMD: `${python} ${slashes(path.join(dir, 'backup.py'))}`,
      ZVONIX_EXPORT_OWNER: '',
      ZVONIX_BACKUP_OWNER: '',
      ZVONIX_ENV_FILE: path.join(dir, 'нет-такого-файла'),
      ZVONIX_GITHUB_ENV: path.join(dir, 'нет-такого-файла'),
      FAKE_DIR: dir,
      ...extra,
    },
  });
}

interface Listing {
  items: {
    id: string;
    kind: string;
    size: number;
    check: { ok: boolean; detail: string } | null;
  }[];
  last_export: { id: string; by: string } | null;
}

const listing = (): Listing =>
  JSON.parse(readFileSync(exchange('backups.json'), 'utf8')) as Listing;
const state = (id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(exchange('runs', id, 'state.json'), 'utf8')) as Record<string, unknown>;
const calls = (): string[] =>
  existsSync(path.join(dir, 'calls.log'))
    ? readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n')
    : [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zvonix-backups-'));
  setup();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('список копий', () => {
  it('все виды, свежие первыми, без чужих файлов; проверок и скачиваний ещё не было', () => {
    runUpdater();
    const { items, last_export: lastExport } = listing();
    expect(items.map((item) => item.id).sort()).toEqual([
      'daily/daily-20261018-030000.dump',
      'manual/manual-20261017-100000.dump',
      'update/v0.1.125-20261018120000.dump',
    ]);
    expect(items.map((item) => item.kind).sort()).toEqual(['daily', 'manual', 'update']);
    expect(items.every((item) => item.check === null && item.size > 0)).toBe(true);
    expect(lastExport).toBeNull();
  });
});

describe('создание копии', () => {
  it('«сейчас» — вид manual, новая копия сразу в списке', () => {
    const id = enqueue({ action: 'backup-create' });
    runUpdater();
    expect(state(id)['status']).toBe('succeeded');
    expect(listing().items.map((item) => item.id)).toContain('manual/manual-20261019-120000.dump');
  });
});

describe('проверка копии', () => {
  const target = 'daily/daily-20261018-030000.dump';

  it('разворачивается во временной базе, считает таблицы и строки, временную базу убирает', () => {
    const id = enqueue({ action: 'backup-verify', target });
    runUpdater();
    expect(state(id)).toMatchObject({ status: 'succeeded', target });
    const item = listing().items.find((entry) => entry.id === target);
    expect(item?.check).toMatchObject({ ok: true });
    // «платежей» нет в копии — это не провал: считается то, что нашлось.
    expect(item?.check?.detail).toBe('таблиц 14, пользователей 3, клиентов 0, партнёров 0');
    const log = calls();
    expect(log.at(-1)).toBe('dropdb --if-exists zvonix_verify');
    // Рабочая база не названа ни одной командой.
    expect(log.some((line) => line.split(' ').includes('zvonix'))).toBe(false);
  });

  it('копия не разворачивается — провал записан, временная база всё равно убрана', () => {
    const id = enqueue({ action: 'backup-verify', target });
    runUpdater({ FAKE_RESTORE_FAIL: '1' });
    expect(state(id)['status']).toBe('failed');
    const item = listing().items.find((entry) => entry.id === target);
    expect(item?.check?.ok).toBe(false);
    expect(item?.check?.detail).toContain('не разворачивается');
    expect(calls().at(-1)).toBe('dropdb --if-exists zvonix_verify');
  });

  it('в оглавлении почти нет таблиц — это повреждённая копия', () => {
    const id = enqueue({ action: 'backup-verify', target });
    runUpdater({ FAKE_FEW_TABLES: '1' });
    expect(state(id)['status']).toBe('failed');
    expect(listing().items.find((entry) => entry.id === target)?.check?.ok).toBe(false);
  });

  it('копия называется только существующим файлом из каталога копий', () => {
    for (const bad of [
      '../../etc/passwd',
      'daily/../../x.dump',
      'nope/x.dump',
      '/etc/passwd',
      'daily/a b.dump',
    ]) {
      const id = enqueue({ action: 'backup-verify', target: bad });
      runUpdater();
      // Негодная заявка удаляется и не получает состояния: выполнять нечего.
      expect(existsSync(exchange('runs', id, 'state.json'))).toBe(false);
      expect(existsSync(exchange('requests', `${id}.json`))).toBe(false);
    }
    // Шаблон верный, файла нет — заявка принята и проваливается честно.
    const id = enqueue({
      action: 'backup-verify',
      target: 'daily/daily-none.dump',
    });
    runUpdater();
    expect(state(id)['status']).toBe('failed');
  });
});

describe('выдача для скачивания', () => {
  const target = 'manual/manual-20261017-100000.dump';

  it('копия кладётся в exports/ под идентификатором заявки; кто и когда — запоминается', () => {
    const id = enqueue({ action: 'backup-export', target, by: 'owner@example.test' });
    runUpdater();
    expect(state(id)['status']).toBe('succeeded');
    expect(readFileSync(exchange('exports', `${id}.dump`), 'utf8')).toBe('ручная');
    expect(listing().last_export).toMatchObject({ id: target, by: 'owner@example.test' });
  });

  it('невзятая выдача через полчаса удаляется: в ней вся база', () => {
    const id = enqueue({ action: 'backup-export', target });
    runUpdater();
    const file = exchange('exports', `${id}.dump`);
    expect(existsSync(file)).toBe(true);
    const old = new Date(Date.now() - 31 * 60_000);
    utimesSync(file, old, old);
    runUpdater();
    expect(existsSync(file)).toBe(false);
  });
});

describe('загруженная копия', () => {
  const put = (id: string, content = 'PGDMP-копия'): void => {
    mkdirSync(exchange('uploads'), { recursive: true });
    writeFileSync(exchange('uploads', `${id}.dump`), content);
  };

  it('файл проверяется, становится копией вида «uploaded», исходный файл уходит; в список она попадает со всеми видами', () => {
    const upload = randomUUID();
    put(upload);
    const id = enqueue({ action: 'backup-import', target: upload });
    runUpdater();
    expect(state(id)).toMatchObject({ status: 'succeeded', exit_code: 0 });
    expect(existsSync(exchange('uploads', `${upload}.dump`))).toBe(false);
    const imported = listing().items.filter((item) => item.kind === 'uploaded');
    expect(imported).toHaveLength(1);
    expect(imported[0]?.id).toMatch(/^uploaded\/uploaded-\d{8}-\d{6}\.dump$/u);
    expect(readFileSync(path.join(dir, 'backups', imported[0]?.id ?? ''), 'utf8')).toBe(
      'PGDMP-копия',
    );
    // Ни одна команда не тронула рабочую базу: только чтение оглавления.
    expect(calls().filter((line) => !line.startsWith('pg_restore --list'))).toEqual([]);
  });

  it('в файле мало таблиц — не копия: провал, в список не попадает', () => {
    const upload = randomUUID();
    put(upload);
    const id = enqueue({ action: 'backup-import', target: upload });
    runUpdater({ FAKE_FEW_TABLES: '1' });
    expect(state(id)).toMatchObject({ status: 'failed' });
    expect(listing().items.filter((item) => item.kind === 'uploaded')).toEqual([]);
  });

  it('такого файла нет — провал; чужой путь в заявке (не идентификатор) — заявка отбрасывается', () => {
    const missing = enqueue({ action: 'backup-import', target: randomUUID() });
    const traversal = enqueue({ action: 'backup-import', target: '../../etc/passwd' });
    runUpdater();
    expect(state(missing)).toMatchObject({ status: 'failed' });
    expect(existsSync(exchange('runs', traversal))).toBe(false);
  });

  it('загруженное и не принятое лежит не дольше часа', () => {
    const stale = randomUUID();
    put(stale);
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(exchange('uploads', `${stale}.dump`), old, old);
    const fresh = randomUUID();
    put(fresh);
    runUpdater();
    expect(existsSync(exchange('uploads', `${stale}.dump`))).toBe(false);
    expect(existsSync(exchange('uploads', `${fresh}.dump`))).toBe(true);
  });
});
