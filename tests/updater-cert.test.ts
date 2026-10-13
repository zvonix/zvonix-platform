/**
 * Служба обновления: сертификат кабинета ([ADR-0083](../docs/adr/0083-sertifikat-v-nastroykah.md)).
 *
 * Запускается настоящий `deploy/updater.py` с подставными `openssl`, `certbot` и `systemctl`
 * (Python-скрипты, имена команд — через окружение). Проверяется то, что нельзя проверить глядя
 * на код: какие имена уходят в certbot, откуда они берутся и что заявка домен назвать не может.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Каждый запуск службы — несколько процессов Python; на Windows это секунды.
vi.setConfig({ testTimeout: 60_000 });

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const updater = path.join(root, 'deploy', 'updater.py');
/** Пути для `shlex.split` в службе: без обратных слэшей. */
const slashes = (value: string): string => value.split(path.sep).join('/');

const FAKE_OPENSSL = `
import sys
print("notBefore=Oct 11 13:24:18 2026 GMT")
print("notAfter=Jan  9 13:24:17 2027 GMT")
print("issuer=C = US, O = Let's Encrypt, CN = YE1")
print("X509v3 Subject Alternative Name: ")
print("    DNS:cp.zvonix.com, DNS:zvonix.com")
`;

const FAKE_CERTBOT = `
import json, os, sys
with open(os.environ["FAKE_DIR"] + "/certbot-args.json", "w") as f:
    json.dump(sys.argv[1:], f)
print("Successfully received certificate")
sys.exit(1 if os.environ.get("FAKE_CERTBOT_FAIL") else 0)
`;

const FAKE_SYSTEMCTL = `
import os, sys
state = os.environ["FAKE_DIR"] + "/timer"
args = sys.argv[1:]
on = not os.path.exists(state + ".off")
if args[0] == "is-enabled":
    print("enabled" if on else "disabled"); sys.exit(0 if on else 1)
if args[0] == "is-active":
    print("active" if on else "inactive"); sys.exit(0 if on else 3)
if args[0] == "enable":
    if os.path.exists(state + ".off"): os.remove(state + ".off")
if args[0] == "disable":
    open(state + ".off", "w").close()
`;

let dir = '';

function setup(environment: { webBaseUrl: string; siteDomain?: string }): void {
  writeFileSync(path.join(dir, 'openssl.py'), FAKE_OPENSSL);
  writeFileSync(path.join(dir, 'certbot.py'), FAKE_CERTBOT);
  writeFileSync(path.join(dir, 'systemctl.py'), FAKE_SYSTEMCTL);
  writeFileSync(
    path.join(dir, 'zvonix.env'),
    `APP_ENV=production\nWEB_BASE_URL=${environment.webBaseUrl}\n`,
  );
  if (environment.siteDomain !== undefined) {
    writeFileSync(path.join(dir, 'site-domain'), `${environment.siteDomain}\n`);
  }
  mkdirSync(path.join(dir, 'exchange', 'requests'), { recursive: true });
  // Сертификат «на диске»: содержимое подставному openssl не важно, нужен сам файл.
  const live = path.join(dir, 'letsencrypt', 'live', 'cp.zvonix.com');
  mkdirSync(live, { recursive: true });
  writeFileSync(path.join(live, 'fullchain.pem'), 'fake');
}

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

function runUpdater(extra: Record<string, string> = {}): void {
  const exe = (name: string): string => `${python} ${slashes(path.join(dir, `${name}.py`))}`;
  execFileSync(python, [updater], {
    stdio: 'pipe',
    env: {
      ...process.env,
      ZVONIX_UPDATER_DIR: path.join(dir, 'exchange'),
      ZVONIX_ENV_FILE: path.join(dir, 'zvonix.env'),
      ZVONIX_SITE_DOMAIN_FILE: path.join(dir, 'site-domain'),
      ZVONIX_LETSENCRYPT_DIR: path.join(dir, 'letsencrypt'),
      ZVONIX_ACME_ROOT: slashes(path.join(dir, 'acme')),
      ZVONIX_GITHUB_ENV: path.join(dir, 'нет-такого-файла'),
      ZVONIX_OPENSSL_CMD: exe('openssl'),
      ZVONIX_CERTBOT_CMD: exe('certbot'),
      ZVONIX_SYSTEMCTL_CMD: exe('systemctl'),
      FAKE_DIR: dir,
      ...extra,
    },
  });
}

const status = (): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(dir, 'exchange', 'certificate.json'), 'utf8')) as Record<
    string,
    unknown
  >;

const state = (id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(dir, 'exchange', 'runs', id, 'state.json'), 'utf8')) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zvonix-cert-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('состояние сертификата', () => {
  it('имена берутся из файлов сервера, даты и выпускающий — из сертификата, таймер — из systemd', () => {
    setup({ webBaseUrl: 'https://cp.zvonix.com', siteDomain: 'zvonix.com' });
    runUpdater();

    expect(status()).toMatchObject({
      cert_name: 'cp.zvonix.com',
      expected_names: ['cp.zvonix.com', 'zvonix.com', 'www.zvonix.com'],
      covered_names: ['cp.zvonix.com', 'zvonix.com'],
      present: true,
      not_before: '2026-10-11T13:24:18+00:00',
      not_after: '2027-01-09T13:24:17+00:00',
      issuer: "Let's Encrypt",
      auto_renew: true,
      auto_renew_active: true,
    });
  });

  it('кабинет не на домене (туннель) — сертификата не ждём и не выпускаем', () => {
    setup({ webBaseUrl: 'http://localhost:8080' });
    const id = enqueue({ action: 'cert-issue' });
    runUpdater();

    expect(status()).toMatchObject({ cert_name: null, expected_names: [], present: false });
    expect(state(id)).toMatchObject({ status: 'failed', exit_code: 1 });
    expect(() => readFileSync(path.join(dir, 'certbot-args.json'))).toThrow();
  });
});

describe('выпуск сертификата', () => {
  it('certbot получает все три имени и общее имя сертификата; домен из заявки игнорируется', () => {
    setup({ webBaseUrl: 'https://cp.zvonix.com', siteDomain: 'zvonix.com' });
    const id = enqueue({ action: 'cert-issue', domain: 'evil.example', names: ['evil.example'] });
    runUpdater();

    const args = JSON.parse(readFileSync(path.join(dir, 'certbot-args.json'), 'utf8')) as string[];
    const names = args.flatMap((arg, index) => (args[index - 1] === '-d' ? [arg] : []));
    expect(names).toEqual(['cp.zvonix.com', 'zvonix.com', 'www.zvonix.com']);
    expect(args).toContain('--expand');
    expect(args[args.indexOf('--cert-name') + 1]).toBe('cp.zvonix.com');
    expect(args.join(' ')).not.toContain('evil.example');
    expect(state(id)).toMatchObject({ action: 'cert-issue', status: 'succeeded', exit_code: 0 });
  });

  it('отказ certbot — заявка «failed» с причиной в журнале, сертификат в состоянии прежний', () => {
    setup({ webBaseUrl: 'https://cp.zvonix.com' });
    const id = enqueue({ action: 'cert-issue' });
    runUpdater({ FAKE_CERTBOT_FAIL: '1' });

    expect(state(id)).toMatchObject({ status: 'failed', exit_code: 1 });
    expect(status()).toMatchObject({ present: true, expected_names: ['cp.zvonix.com'] });
  });
});

describe('автопродление', () => {
  it('выключается и включается таймером certbot, а состояние показывает его', () => {
    setup({ webBaseUrl: 'https://cp.zvonix.com' });
    const off = enqueue({ action: 'cert-auto-off' });
    runUpdater();
    expect(state(off)).toMatchObject({ status: 'succeeded' });
    expect(status()).toMatchObject({ auto_renew: false, auto_renew_active: false });

    const on = enqueue({ action: 'cert-auto-on' });
    runUpdater();
    expect(state(on)).toMatchObject({ status: 'succeeded' });
    expect(status()).toMatchObject({ auto_renew: true, auto_renew_active: true });
  });
});
