/**
 * Восстановление из копии на НАСТОЯЩЕЙ PostgreSQL ([ADR-0086](../docs/adr/0086-rezervnye-kopii-v-kabinete.md)).
 *
 * `updater-restore.test.ts` проверяет порядок шагов на подставных командах; здесь — то, чего подставные команды не
 * покажут: что `pg_restore`, переименование баз и отключение пользователей работают как задумано, в том числе когда
 * к рабочей базе в момент подмены подключён клиент. Базы временные и называются иначе, чем рабочая (`ZVONIX_LIVE_DB`).
 *
 * Нужны `psql`, `pg_dump`, `pg_restore` и `TEST_DATABASE_URL` (роль с правом создавать базы). Каталог инструментов — в
 * `ZVONIX_TEST_PG_BIN`, иначе ищутся в PATH. Нет чего-то из этого — проверка пропускается, а не падает.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_READY, FAKE_SYSTEMCTL } from './updater-fakes.js';

vi.setConfig({ testTimeout: 120_000 });

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const updater = path.join(root, 'deploy', 'updater.py');
const slashes = (value: string): string => value.split(path.sep).join('/');

const binDir = process.env['ZVONIX_TEST_PG_BIN'] ?? '';
const tool = (name: string): string => (binDir === '' ? name : path.join(binDir, name));

const databaseUrl = process.env['TEST_DATABASE_URL'];
const connection = ((): {
  PGHOST: string;
  PGPORT: string;
  PGUSER: string;
  PGPASSWORD: string;
} | null => {
  if (databaseUrl === undefined) return null;
  try {
    const url = new URL(databaseUrl);
    return {
      PGHOST: url.hostname,
      PGPORT: url.port === '' ? '5432' : url.port,
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
    };
  } catch {
    return null;
  }
})();
const toolsPresent =
  spawnSync(tool('psql'), ['--version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync(tool('pg_restore'), ['--version'], { stdio: 'ignore' }).status === 0;
const available = connection !== null && toolsPresent;

const env = { ...process.env, ...(connection ?? {}) };

function psql(database: string, statement: string): string {
  return execFileSync(
    tool('psql'),
    ['-d', database, '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement],
    {
      env,
      encoding: 'utf8',
    },
  ).trim();
}

const names = (live: string): string[] =>
  psql('postgres', `select datname from pg_database where datname like '${live}%' order by 1`)
    .split(/\r?\n/u)
    .filter((line) => line !== '');

/** Строка в `payments`: сколько записей в базе — «до копии» три, «после неё» ещё две. */
const rows = (database: string): number => Number(psql(database, 'select count(*) from payments'));

/** Копирует базу в файл `pg_dump`-ом, как это делает `zvonix-backup`; для подставной страховочной копии. */
const FAKE_BACKUP_REAL = `
import os, subprocess, sys
kind = sys.argv[1]
directory = os.environ["FAKE_DIR"] + "/backups/" + kind
os.makedirs(directory, exist_ok=True)
target = directory + "/" + kind + "-20261019-130000.dump"
subprocess.run([os.environ["FAKE_PG_DUMP"], "-Fc", "-f", target, os.environ["ZVONIX_LIVE_DB"]], check=True)
`;

const FAKE_MIGRATE_OK = `
import sys
sys.exit(0)
`;

let dir = '';
let live = '';
let holder: ChildProcess | undefined;
const exchange = (...parts: string[]): string => path.join(dir, 'exchange', ...parts);
const target = 'daily/daily-20261018-030000.dump';

function prepare(): void {
  dir = mkdtempSync(path.join(tmpdir(), 'zvonix-pgrestore-'));
  live = `zvx_rh_${randomUUID().replace(/-/gu, '').slice(0, 10)}`;
  for (const [name, source] of [
    ['systemctl', FAKE_SYSTEMCTL],
    ['ready', FAKE_READY],
    ['backup', FAKE_BACKUP_REAL],
    ['migrate', FAKE_MIGRATE_OK],
  ] as const) {
    writeFileSync(path.join(dir, `${name}.py`), source);
  }
  mkdirSync(exchange('requests'), { recursive: true });
  mkdirSync(path.join(dir, 'backups', 'daily'), { recursive: true });

  // Рабочая база с тремя платежами; копия снимается; потом появляются ещё два («после копии»).
  psql('postgres', `create database ${live}`);
  psql(live, 'create table payments (id serial primary key, amount int not null)');
  psql(live, 'insert into payments (amount) values (100), (200), (300)');
  execFileSync(
    tool('pg_dump'),
    ['-Fc', '-f', path.join(dir, 'backups', 'daily', 'daily-20261018-030000.dump'), live],
    { env },
  );
  psql(live, 'insert into payments (amount) values (400), (500)');
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

function runUpdater(): void {
  const exe = (name: string): string => `${python} ${slashes(path.join(dir, `${name}.py`))}`;
  execFileSync(python, [updater], {
    stdio: 'pipe',
    env: {
      ...env,
      ZVONIX_UPDATER_DIR: exchange(),
      ZVONIX_BACKUPS_DIR: path.join(dir, 'backups'),
      ZVONIX_LIVE_DB: live,
      // В тестовой базе одна таблица: порог «настоящей копии» (десять) здесь снижен.
      ZVONIX_MIN_TABLES: '1',
      ZVONIX_DB_OWNER: connection?.PGUSER ?? 'zvonix',
      ZVONIX_PG_PREFIX: '',
      ZVONIX_PG_BIN_DIR: binDir,
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
      FAKE_PG_DUMP: tool('pg_dump'),
    },
  });
}

/** Журнал заявки: при провале показывается в сообщении проверки — иначе причину пришлось бы искать вручную. */
const journal = (id: string): string => readFileSync(exchange('runs', id, 'log'), 'utf8');

const state = (id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(exchange('runs', id, 'state.json'), 'utf8')) as Record<string, unknown>;

/** Клиент, который держит подключение к рабочей базе в момент подмены (как кабинет или воркер до остановки). */
function holdConnection(): void {
  holder = spawn(tool('psql'), ['-d', live, '-c', 'select pg_sleep(120)'], {
    env,
    stdio: 'ignore',
  });
}

beforeEach(() => {
  if (!available) return;
  prepare();
});

afterEach(() => {
  holder?.kill();
  holder = undefined;
  if (available && live !== '') {
    for (const name of names(live)) psql('postgres', `drop database if exists ${name}`);
  }
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available)('восстановление на настоящей PostgreSQL', () => {
  it('рабочая база возвращается к состоянию копии, прежняя сохраняется целиком, подключённый клиент отключён', () => {
    holdConnection();
    // Подключение должно успеть появиться: иначе проверка отключения ничего не проверит.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const clients = Number(
        psql(
          'postgres',
          `select count(*) from pg_stat_activity where datname = '${live}' and state = 'active'`,
        ),
      );
      if (clients > 0) break;
      spawnSync(python, ['-c', 'import time; time.sleep(0.1)']);
    }

    const id = enqueue();
    runUpdater();
    expect(state(id), journal(id)).toMatchObject({ status: 'succeeded' });

    // Рабочая база — состояние копии: три платежа, а не пять.
    expect(rows(live)).toBe(3);
    // Прежняя — рядом, целиком: все пять платежей на месте.
    const replaced = names(live).filter((name) => name.includes('_replaced_'));
    expect(replaced).toHaveLength(1);
    expect(rows(replaced[0] ?? '')).toBe(5);
    // Временной базы восстановления и проверки не осталось.
    expect(names(live).some((name) => name.endsWith('_restore') || name.endsWith('_verify'))).toBe(
      false,
    );
  });

  it('службы не поднялись — прежняя база (пять платежей) снова рабочая, восстановленная сохранена отдельно', () => {
    writeFileSync(path.join(dir, 'not-ready'), '');
    holdConnection();
    const id = enqueue();
    runUpdater();
    expect(state(id)).toMatchObject({ status: 'failed' });

    expect(rows(live)).toBe(5);
    const failed = names(live).filter((name) => name.includes('_failed_'));
    expect(failed).toHaveLength(1);
    expect(rows(failed[0] ?? '')).toBe(3);
    // Рабочая база принимает подключения: возврат не оставил её запертой.
    expect(psql('postgres', `select datallowconn from pg_database where datname = '${live}'`)).toBe(
      't',
    );
  });
});
