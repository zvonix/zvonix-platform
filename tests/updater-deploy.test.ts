/**
 * Служба обновления: подтверждение миграций, меняющих данные ([ADR-0086](../docs/adr/0086-rezervnye-kopii-v-kabinete.md),
 * часть 3). Ключ `--allow-risky` выкладка получает только от заявки, где администратор его явно подтвердил: строка,
 * число и чужие действия его не включают.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const updater = path.join(root, 'deploy', 'updater.py');
const slashes = (value: string): string => value.split(path.sep).join('/');

/** Подставная выкладка: пишет свои аргументы одной строкой. */
const FAKE_DEPLOY = `
import json, os, sys
with open(os.environ["FAKE_DIR"] + "/deploy-args.json", "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
`;

let dir = '';

function enqueue(request: Record<string, unknown>): void {
  mkdirSync(path.join(dir, 'exchange', 'requests'), { recursive: true });
  writeFileSync(
    path.join(dir, 'exchange', 'requests', `${randomUUID()}.json`),
    JSON.stringify({
      tag: null,
      by: 'admin@example.test',
      at: new Date().toISOString(),
      ...request,
    }),
  );
}

function runUpdater(): string[][] {
  writeFileSync(path.join(dir, 'deploy.py'), FAKE_DEPLOY);
  execFileSync(python, [updater], {
    stdio: 'pipe',
    env: {
      ...process.env,
      ZVONIX_UPDATER_DIR: path.join(dir, 'exchange'),
      ZVONIX_DEPLOY_CMD: `${python} ${slashes(path.join(dir, 'deploy.py'))}`,
      ZVONIX_BACKUPS_DIR: path.join(dir, 'backups'),
      ZVONIX_ENV_FILE: path.join(dir, 'нет-такого-файла'),
      ZVONIX_GITHUB_ENV: path.join(dir, 'нет-такого-файла'),
      FAKE_DIR: dir,
    },
  });
  return readFileSync(path.join(dir, 'deploy-args.json'), 'utf8')
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as string[]);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zvonix-deploy-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('подтверждение «миграции меняют данные»', () => {
  it('только явное «да» в заявке даёт выкладке --allow-risky', () => {
    enqueue({ action: 'deploy', tag: 'v1.2.3', allow_risky: true });
    expect(runUpdater()).toEqual([['v1.2.3', '--allow-risky']]);
  });

  it('без подтверждения, со строкой или числом — обычная выкладка', () => {
    enqueue({ action: 'deploy', tag: 'v1.2.3' });
    enqueue({ action: 'deploy', tag: 'v1.2.4', allow_risky: 'true' });
    enqueue({ action: 'deploy', tag: 'v1.2.5', allow_risky: 1 });
    const calls = runUpdater();
    expect(calls).toHaveLength(3);
    expect(calls.flat()).not.toContain('--allow-risky');
  });

  it('проверка выпуска и откат подтверждения не принимают', () => {
    enqueue({ action: 'prepare', tag: 'v1.2.3', allow_risky: true });
    enqueue({ action: 'rollback', allow_risky: true });
    const calls = runUpdater();
    expect(calls.flat()).not.toContain('--allow-risky');
  });
});

describe('после выкладки служба начинает работать новым кодом сразу', () => {
  // На Windows (где идут проверки) exec не подменяет процесс, поэтому перезапуск самой себя там отключён.
  it.skipIf(process.platform === 'win32')(
    'перезапускается один раз: выкладка выполнена ровно раз, список копий записан, цикла нет',
    () => {
      enqueue({ action: 'deploy', tag: 'v1.2.3' });
      const calls = runUpdater();
      expect(calls).toEqual([['v1.2.3']]);
      expect(existsSync(path.join(dir, 'exchange', 'backups.json'))).toBe(true);
    },
  );
});
