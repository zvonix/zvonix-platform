/**
 * Служба обновления: токен GitHub ([ADR-0084](../docs/adr/0084-token-github-v-nastroykah.md)).
 *
 * Запускается настоящий `deploy/updater.py`, а вместо GitHub — локальный HTTP-сервер (адрес через окружение).
 * Проверяется то, что нельзя увидеть по коду: токен записывается только после проверки у GitHub, репозиторий
 * берётся из файла root, а сам токен нигде, кроме `github.env`, не остаётся.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const updater = path.join(root, 'deploy', 'updater.py');

const GOOD = 'github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz0123456789';
const BAD = 'github_pat_11BBBBBBB0abcdefghijklmnopqrstuvwxyz0123456789';
const FORBIDDEN = 'github_pat_11CCCCCCC0abcdefghijklmnopqrstuvwxyz0123456789';

let dir = '';
let server: Server;
let apiUrl = '';
const asked: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'zvonix-token-'));
  asked.length = 0;
  server = createServer((request, response) => {
    asked.push(`${request.method ?? ''} ${request.url ?? ''}`);
    const auth = request.headers.authorization ?? '';
    if (auth === `Bearer ${GOOD}`) {
      response.writeHead(200, {
        'content-type': 'application/json',
        'github-authentication-token-expiration': '2026-12-31 12:00:00 UTC',
      });
      response.end('[]');
    } else if (auth === `Bearer ${FORBIDDEN}`) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"message":"Not Found"}');
    } else {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"message":"Bad credentials"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  mkdirSync(path.join(dir, 'exchange', 'requests'), { recursive: true });
  writeFileSync(
    path.join(dir, 'github.env'),
    'GITHUB_REPOSITORY=zvonix/zvonix-platform\nGITHUB_TOKEN=old_token_value_1234567890\nKEEP=1\n',
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  rmSync(dir, { recursive: true, force: true });
});

function enqueue(request: Record<string, unknown>): string {
  const id = randomUUID();
  writeFileSync(
    path.join(dir, 'exchange', 'requests', `${id}.json`),
    JSON.stringify({
      tag: null,
      by: 'admin@example.test',
      at: new Date().toISOString(),
      ...request,
    }),
  );
  return id;
}

async function runUpdater(): Promise<void> {
  await run(python, [updater], {
    env: {
      ...process.env,
      ZVONIX_UPDATER_DIR: path.join(dir, 'exchange'),
      ZVONIX_GITHUB_ENV: path.join(dir, 'github.env'),
      ZVONIX_GITHUB_API: apiUrl,
      // Сертификат этим проверкам не нужен: файлы кабинета и сертификатов указывают в пустоту.
      ZVONIX_ENV_FILE: path.join(dir, 'нет-такого-файла'),
      ZVONIX_SITE_DOMAIN_FILE: path.join(dir, 'нет-такого-файла'),
      ZVONIX_LETSENCRYPT_DIR: path.join(dir, 'letsencrypt'),
    },
  });
}

const env = (): string => readFileSync(path.join(dir, 'github.env'), 'utf8');
const state = (id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(dir, 'exchange', 'runs', id, 'state.json'), 'utf8')) as Record<
    string,
    unknown
  >;
const log = (id: string): string =>
  readFileSync(path.join(dir, 'exchange', 'runs', id, 'log'), 'utf8');
const status = (): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(dir, 'exchange', 'github-token.json'), 'utf8')) as Record<
    string,
    unknown
  >;

/** Все файлы обменного каталога, кроме `github.env`: токен не должен оказаться ни в одном. */
function exchangeText(): string {
  const parts: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else parts.push(readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(dir, 'exchange'));
  return parts.join('\n');
}

describe('токен GitHub', () => {
  it('принятый GitHub токен записывается, остальные строки сохраняются, срок виден кабинету', async () => {
    const id = enqueue({ action: 'token-set', token: GOOD });
    await runUpdater();

    expect(env()).toContain(`GITHUB_TOKEN=${GOOD}`);
    expect(env()).toContain('GITHUB_REPOSITORY=zvonix/zvonix-platform');
    expect(env()).toContain('KEEP=1');
    expect(env()).not.toContain('old_token_value');
    expect(state(id)).toMatchObject({ action: 'token-set', status: 'succeeded', exit_code: 0 });
    expect(status()).toMatchObject({
      valid: true,
      repository: 'zvonix/zvonix-platform',
      expires_at: '2026-12-31T12:00:00+00:00',
      problem: null,
    });
    // Проверка шла у GitHub по адресу репозитория из файла root.
    expect(asked[0]).toContain('/repos/zvonix/zvonix-platform/releases');
    // Токена нет ни в состоянии, ни в журнале, ни в статусе, ни в остатках заявки.
    expect(exchangeText()).not.toContain(GOOD);
    if (process.platform !== 'win32') {
      expect(statSync(path.join(dir, 'github.env')).mode & 0o777).toBe(0o600);
    }
  });

  it('токен, который GitHub не принял, не записывается: прежний остаётся', async () => {
    const id = enqueue({ action: 'token-set', token: BAD });
    await runUpdater();

    expect(env()).toContain('GITHUB_TOKEN=old_token_value_1234567890');
    expect(env()).not.toContain(BAD);
    expect(state(id)).toMatchObject({ status: 'failed', exit_code: 1 });
    expect(log(id)).toContain('не принял токен');
    expect(exchangeText()).not.toContain(BAD);
  });

  it('нет доступа к репозиторию — подсказка про организацию и право, токен не записан', async () => {
    const id = enqueue({ action: 'token-set', token: FORBIDDEN });
    await runUpdater();

    expect(env()).not.toContain(FORBIDDEN);
    expect(state(id)).toMatchObject({ status: 'failed' });
    expect(log(id)).toContain('Contents: Read-only');
    expect(exchangeText()).not.toContain(FORBIDDEN);
  });

  it('репозиторий заявкой не задаётся, а токен негодной формы отбрасывается до исполнения', async () => {
    const evil = enqueue({ action: 'token-set', token: GOOD, repository: 'evil/repo' });
    const malformed = enqueue({ action: 'token-set', token: 'не токен; rm -rf /' });
    await runUpdater();

    // Первая заявка выполнена с репозиторием из github.env; вторая отброшена — запуска у неё нет.
    expect(asked.some((line) => line.includes('/repos/zvonix/zvonix-platform/'))).toBe(true);
    expect(asked.some((line) => line.includes('evil/repo'))).toBe(false);
    expect(state(evil)).toMatchObject({ status: 'succeeded' });
    expect(() => state(malformed)).toThrow();
  });
});
