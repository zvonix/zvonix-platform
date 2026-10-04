/**
 * Раздача установщика узла ([ADR-0045](../../../../../docs/adr/0045-ustanovshchik-uzla.md)).
 *
 * Проверяется то, из-за чего установка не работала вовсе: отдаётся ли скрипт по адресу,
 * который называет панель, собирается ли он целиком и **остаётся ли он при этом
 * исполнимым**. Последнее не очевидно: внутрь вкладывается XML, и ошибка в сборке
 * даст синтаксически битый скрипт, который выяснится на живой машине.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { prepareEnvironment, resetDatabase, startApi } from '../../testing/harness.js';

const REPO = 'https://packages.zvonix.test/ubuntu';
const FINGERPRINT = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4';

/** Набор конфигурации узла в репозитории — с ним сверяется разложенное на «узле». */
const NODE_CONF = path.join(import.meta.dirname, '..', '..', '..', '..', '..', 'node', 'conf');

prepareEnvironment({
  NODE_PACKAGE_REPO_URL: REPO,
  NODE_PACKAGE_SUITE: 'noble',
  NODE_PACKAGE_KEY_FINGERPRINT: FINGERPRINT,
});

let app: NestFastifyApplication | undefined;
let script = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  const response = await api().inject({ method: 'GET', url: '/install.sh' });
  expect(response.statusCode).toBe(200);
  script = response.body;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('установщик узла', () => {
  it('отдаётся без ключа: на чистой машине предъявить нечего', async () => {
    const response = await api().inject({ method: 'GET', url: '/install.sh' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/x-shellscript');
    // Промежуточный кэш, отдавший вчерашний скрипт, проявился бы установкой,
    // которая «работала на прошлой неделе».
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('параметры площадки подставлены', () => {
    expect(script).toContain(REPO);
    expect(script).toContain(FINGERPRINT);
    expect(script).toContain('noble');
  });

  it('шаблоны конфигурации вложены внутрь, а не читаются с диска', () => {
    // Из-за чтения с диска установка и падала: в конвейере `curl | bash`
    // каталога `./conf` рядом со скриптом не существует.
    expect(script).toContain('<configuration name="xml_curl.conf"');
    expect(script).toContain('<configuration name="json_cdr.conf"');
    expect(script).not.toContain('dirname "$0"');
  });

  it('подстановки внутри XML оставлены узлу: ключа до обмена токена не существует', () => {
    // Все три подставляет `sed` на узле, одним проходом. `@@CONTROL_PLANE@@` здесь
    // не забытая подстановка, а часть шаблона: адрес известен и площадке, но правило
    // «XML заполняет узел» лучше одного исключения из него.
    expect(script).toContain('@@KEY_ID@@');
    expect(script).toContain('@@KEY_SECRET@@');
    expect(script).toContain('@@CONTROL_PLANE@@');
  });

  it('подстановки самого скрипта заполнены', () => {
    for (const placeholder of [
      '@@PACKAGE_REPO@@',
      '@@PACKAGE_SUITE@@',
      '@@PACKAGE_KEY_FINGERPRINT@@',
      '@@CONF_FILES@@',
      '@@FAIL2BAN_FILES@@',
    ]) {
      expect(`${placeholder} осталась: ${String(script.includes(placeholder))}`).toBe(
        `${placeholder} осталась: false`,
      );
    }

    // Адрес control plane — отдельно: одноимённая подстановка живёт и в XML, поэтому
    // проверяется именно строка присвоения, а не наличие где-нибудь в файле.
    expect(script).toContain('CONTROL_PLANE="${ZVONIX_CONTROL_PLANE:-http');
  });

  it('подставленное значение стоит только в своём присваивании', () => {
    // Площадка заменяет **каждое** вхождение метки. Метка, стоявшая ещё и в проверке
    // «не подставлено», превращалась в то же значение, и скрипт сравнивал адрес сам
    // с собой: первый живой запуск (2026-09-22) отказал с «адрес control plane
    // не подставлен», а отпечаток ключа подписи молча не сверялся.
    const occurrences = (value: string) => script.split(value).length - 1;
    expect(occurrences('http://127.0.0.1:8000')).toBe(1);
    expect(occurrences(REPO)).toBe(1);
    expect(occurrences(FINGERPRINT)).toBe(1);
    expect(occurrences('sip.zvonix.test')).toBe(1);
  });

  it('узел раскладывает набор целиком, и в нём не остаётся ни одной метки', () => {
    // Настоящий bash, настоящий раздел конфигурации из собранного скрипта (ADR-0051).
    // Пока `sed` на узле искал целую метку, площадка успевала заменить и её: в конфигурацию
    // FreeSWITCH уходило `@@CONTROL_PLANE@@/node/directory`, и узел не спросил бы маршрут.
    const start = script.indexOf('conf_file() {');
    const end = script.indexOf('# --- Подмена набора и перезапуск');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);

    const directory = mkdtempSync(path.join(tmpdir(), 'zvonix-conf-'));
    const stage = path.join(directory, 'stage');
    const file = path.join(directory, 'stage.sh');
    const eslPassword = 'e'.repeat(48);
    writeFileSync(
      file,
      [
        'set -euo pipefail',
        "MARK='@@'",
        'die() { echo "$*" >&2; exit 1; }',
        // Проверяется раскладка, а не права: в Git Bash под Windows `install -m` отказывает
        // менять права каталога. Права набора видит живая установка на Ubuntu.
        'install() { local a=(); while [ $# -gt 0 ]; do case "$1" in -m) shift 2 ;; -d) shift ;; *) a+=("$1"); shift ;; esac; done; mkdir -p "${a[@]}"; }',
        `STAGE='${stage.replaceAll('\\', '/')}'`,
        'mkdir -p "$STAGE"',
        'CONTROL_PLANE=https://cp.zvonix.test',
        'SIP_REALM=sip.zvonix.test',
        'KEY_ID=zvx_node_test',
        'KEY_SECRET=secret',
        `ESL_PASSWORD=${eslPassword}`,
        script.slice(start, end),
      ].join('\n'),
      'utf8',
    );
    execFileSync('bash', [file], { stdio: 'pipe' });

    // Набор лёг целиком: ровно те файлы, что лежат в node/conf, плюс каталог транков.
    const listed = (root: string) =>
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
        .map((name) => name.split(path.sep).join('/'))
        .sort();
    expect(listed(stage)).toEqual(listed(NODE_CONF));
    expect(existsSync(path.join(stage, 'zvonix-gateways'))).toBe(true);

    const read = (name: string) => readFileSync(path.join(stage, name), 'utf8');
    expect(read('autoload_configs/xml_curl.conf.xml')).toContain(
      'https://cp.zvonix.test/node/directory',
    );
    expect(read('autoload_configs/xml_curl.conf.xml')).toContain('zvx_node_test');
    expect(read('vars.xml')).toContain('data="domain=sip.zvonix.test"');
    expect(read('autoload_configs/event_socket.conf.xml')).toContain(`value="${eslPassword}"`);
    // `$$` в строке замены `replaceAll` превращается в `$`: `$${local_ip_v4}` стал бы
    // переменной канала вместо глобальной, и профиль не нашёл бы свой адрес.
    expect(read('autoload_configs/sofia.conf.xml')).toContain('value="$${local_ip_v4}"');

    // Метки — латиницей: комментарии набора пишут «@@…@@», объясняя их.
    for (const name of listed(stage)) {
      expect(`${name}: ${String(/@@[A-Z_]+@@/u.test(read(name)))}`).toBe(`${name}: false`);
    }
  });

  it('фильтр и тюрьма fail2ban вложены: подбор паролей SIP кладёт площадку', () => {
    // Каждая неудачная регистрация — запрос учётной записи у площадки: один сканер
    // с сотней попыток в секунду занимал половину процессора API (живой узел 2026-09-22).
    expect(script).toContain("fail2ban_file 'filter.d/zvonix-freeswitch.conf'");
    expect(script).toContain("fail2ban_file 'jail.d/zvonix-freeswitch.conf'");
    // Свои логины — отдельной тюрьмой с порогом атаки: шлюз партнёра со старым паролем
    // не должен закрывать его офис от площадки (владелец, 2026-09-25).
    expect(script).toContain("fail2ban_file 'filter.d/zvonix-freeswitch-known.conf'");
    expect(script).toContain('banaction = nftables[type=multiport]');
    expect(script).not.toContain('type=allports');
    expect(script).toContain('SIP auth failure');
    // Журнал у сборки из исходников лежит под её префиксом — путь подставляет узел.
    expect(script).toContain('@@FREESWITCH_LOG@@');
    expect(script).toContain('global_getvar log_dir');
  });

  it('собранный скрипт исполним: внутрь вложен XML, и это могло его сломать', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'zvonix-install-')), 'install.sh');
    writeFileSync(file, script, 'utf8');

    // Тот же способ, что и в `scripts/node-config.mjs`: разбор без исполнения.
    expect(() => {
      execFileSync('bash', ['-n', file], { stdio: 'pipe' });
    }).not.toThrow();
  });

  it('репозиторий требуется только когда FreeSWITCH ставить', () => {
    // Первый узел площадки поднимается до всякого склада пакетов: FreeSWITCH на нём
    // собран руками, и требовать адрес репозитория значило бы не пускать на узел,
    // которому он не нужен.
    expect(script).toContain('if command -v freeswitch >/dev/null 2>&1; then');
    expect(script).toContain('NEED_PACKAGES=no');

    // Отказ «репозиторий не задан» обязан лежать внутри ветки «ставить нужно»,
    // а не до неё: иначе условие ничего не решает.
    const branch = script.indexOf('NEED_PACKAGES=yes');
    const refusal = script.indexOf('FreeSWITCH не установлен, а репозиторий пакетов не задан');
    expect(branch).toBeGreaterThan(0);
    expect(refusal).toBeGreaterThan(branch);

    // И `if`, а не `&&`: при `set -e` цепочка, закончившаяся ложью, роняет скрипт —
    // узел, которому репозиторий не нужен, не установился бы вовсе.
    expect(script).not.toContain('[ "$NEED_PACKAGES" = yes ] && ADDRESSES=');
  });

  it('каталог конфигурации ищется до обмена токена, и не только в /etc', () => {
    // Собранный из исходников FreeSWITCH держит конфигурацию под своим префиксом.
    // Прежняя редакция знала только `/etc/freeswitch` и на первом узле площадки упала бы
    // уже после регистрации, сжёгши одноразовый токен (найдено 2026-09-14 на живой машине).
    const detection = script.indexOf('readlink -f "$(command -v freeswitch)"');
    const refusal = script.indexOf('это не каталог конфигурации FreeSWITCH');
    const enroll = script.indexOf('/node/enroll');

    expect(detection).toBeGreaterThan(0);
    expect(refusal).toBeGreaterThan(detection);
    expect(enroll).toBeGreaterThan(refusal);
    expect(script).not.toContain('CONF_DIR="${ZVONIX_CONF_DIR:-/etc/freeswitch}"');
  });

  it('обмен токена идёт после проверок: неудача не должна его сжигать', () => {
    const checks = script.indexOf('Проверка репозитория пакетов');
    const enroll = script.indexOf('/node/enroll');
    const install = script.indexOf('apt-get install');

    expect(checks).toBeGreaterThan(0);
    expect(enroll).toBeGreaterThan(checks);
    expect(install).toBeGreaterThan(enroll);
  });
});

/**
 * Обновление узла вместе с выпуском (ADR-0051, ревизия 2026-09-29): настоящий bash
 * над участками собранного скрипта, FreeSWITCH и systemd подменены функциями.
 * Проверяется то, что стоит звонков: перезапуск только при изменившемся наборе
 * и только без разговоров на узле, откат при неподнявшемся профиле.
 */
describe('обновление узла', () => {
  const slash = (value: string) => value.replaceAll('\\', '/');

  /** Участок скрипта между двумя метками — целиком, как он придёт на узел. */
  function slice(from: string, to: string): string {
    const start = script.indexOf(from);
    const end = script.indexOf(to, start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return script.slice(start, end);
  }

  function run(file: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = {}) {
    const result = spawnSync('bash', [file, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { status: result.status ?? -1, output: result.stdout + result.stderr };
  }

  /**
   * Подмена набора. `installed` — узел уже обновлялся раньше: штатный набор отложен
   * в `.before-zvonix`, и прежний наш уйдёт в `.previous`, откуда его можно вернуть.
   */
  function swap(options: {
    changed: boolean;
    calls: number;
    profile: 'up' | 'down';
    gateways?: boolean;
    installed?: boolean;
  }) {
    const root = slash(mkdtempSync(path.join(tmpdir(), 'zvonix-update-')));
    const conf = `${root}/conf`;
    const stage = `${conf}.zvonix-new`;
    const directories = [conf, `${conf}/zvonix-gateways`, `${stage}/zvonix-gateways`];
    if (options.installed === true) directories.push(`${conf}.before-zvonix`);
    for (const directory of [...directories, `${root}/state`]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(`${conf}/vars.xml`, 'old', 'utf8');
    writeFileSync(`${stage}/vars.xml`, options.changed ? 'new' : 'old', 'utf8');
    if (options.gateways === true) {
      writeFileSync(`${conf}/zvonix-gateways/trunk.xml`, 'trunk', 'utf8');
    }
    // Сертификаты FreeSWITCH порождает сам в каталоге конфигурации — не наше.
    mkdirSync(`${conf}/tls`);
    writeFileSync(`${conf}/tls/wss.pem`, 'certificate', 'utf8');
    const log = `${root}/systemctl.log`;
    const file = `${root}/swap.sh`;
    writeFileSync(
      file,
      [
        'set -euo pipefail',
        'die() { echo "$*" >&2; exit 1; }',
        'sleep() { :; }',
        'chown() { :; }',
        `systemctl() { echo "$*" >> '${log}'; }`,
        'fs_cli() {',
        '  case "$*" in',
        `    *"show calls count"*) printf '\\n${String(options.calls)} total.\\n' ;;`,
        options.profile === 'up'
          ? `    *"sofia status"*) echo '  zvonix  profile  sip:mod_sofia@192.0.2.1:5060  RUNNING (0)' ;;`
          : `    *"sofia status"*) echo '  internal  profile  sip:mod_sofia@192.0.2.1:5080  RUNNING (0)' ;;`,
        '    *) return 0 ;;',
        '  esac',
        '}',
        'MODE=update',
        'DRAIN_SECONDS=10',
        'ESL_PASSWORD=e',
        `STATE_DIR='${root}/state'`,
        `CONF_DIR='${conf}'`,
        `STAGE='${stage}'`,
        slice('# --- Подмена набора и перезапуск', '# --- Защита от подбора паролей SIP'),
        'echo "POSTPONED=$CONF_POSTPONED"',
      ].join('\n'),
      'utf8',
    );
    const result = run(file);
    return {
      ...result,
      log: existsSync(log) ? readFileSync(log, 'utf8') : '',
      read: (name: string) => {
        const target = `${root}/${name}`;
        return existsSync(target) ? readFileSync(target, 'utf8') : undefined;
      },
    };
  }

  it('набор не изменился — FreeSWITCH не перезапускается', () => {
    const result = swap({ changed: false, calls: 3, profile: 'up' });
    expect(result.output).toContain('POSTPONED=no');
    expect(result.status).toBe(0);
    expect(result.log).not.toContain('restart');
    expect(result.read('conf.zvonix-new/vars.xml')).toBeUndefined();
  });

  it('набор изменился, а звонки не кончаются — конфигурация откладывается, разговоры целы', () => {
    const result = swap({ changed: true, calls: 2, profile: 'up' });
    expect(result.output).toContain('POSTPONED=yes');
    expect(result.status).toBe(0);
    expect(result.log).not.toContain('restart');
    expect(result.read('conf/vars.xml')).toBe('old');
  });

  it('набор изменился, звонков нет — подмена, перезапуск, транки агента на месте', () => {
    const result = swap({
      changed: true,
      calls: 0,
      profile: 'up',
      gateways: true,
      installed: true,
    });
    expect(result.output).toContain('POSTPONED=no');
    expect(result.status).toBe(0);
    expect(result.log).toContain('restart freeswitch');
    expect(result.read('conf/vars.xml')).toBe('new');
    expect(result.read('conf/zvonix-gateways/trunk.xml')).toBe('trunk');
    expect(result.read('conf/tls/wss.pem')).toBe('certificate');
    expect(result.read('conf.previous/vars.xml')).toBe('old');
  });

  it('с новым набором профиль не поднялся — прежний набор возвращается', () => {
    const result = swap({ changed: true, calls: 0, profile: 'down', installed: true });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('возвращена прежняя');
    expect(result.read('conf/vars.xml')).toBe('old');
    expect(result.read('conf.failed/vars.xml')).toBe('new');
  });

  /** Начало скрипта в режиме `--update`: откуда он берёт ключ и каталог конфигурации. */
  function preamble(files: { nodeEnv?: string; heartbeat?: string }) {
    const root = slash(mkdtempSync(path.join(tmpdir(), 'zvonix-preamble-')));
    const etc = `${root}/etc`;
    const conf = `${root}/conf`;
    const bin = `${root}/bin`;
    for (const directory of [etc, `${conf}/autoload_configs`, bin]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(`${conf}/autoload_configs/modules.conf.xml`, '<configuration/>', 'utf8');
    writeFileSync(`${bin}/freeswitch`, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
    if (files.nodeEnv !== undefined) writeFileSync(`${etc}/node.env`, files.nodeEnv, 'utf8');
    if (files.heartbeat !== undefined) {
      writeFileSync(`${etc}/heartbeat.curl`, files.heartbeat, 'utf8');
    }
    const file = `${root}/preamble.sh`;
    writeFileSync(
      file,
      [
        'set -euo pipefail',
        // Скрипт требует root; здесь проверяется разбор, а не права.
        'id() { echo 0; }',
        // Через pwd: в Git Bash путь «C:/…» разорвал бы PATH на двоеточии.
        `PATH="$(cd '${bin}' && pwd):$PATH"`,
        slice('MODE=install', 'require curl'),
        'echo "KEY=$KEY_ID|$KEY_SECRET"',
      ].join('\n'),
      'utf8',
    );
    return run(file, ['--update'], { ZVONIX_CONF_DIR: conf, ZVONIX_NODE_ETC: etc });
  }

  it('без токена: ключ узла берётся из node.env', () => {
    const result = preamble({ nodeEnv: 'KEY_ID=zvx_node_abc123def456\nKEY_SECRET=Se_cr-et\n' });
    expect(result.output).toContain('KEY=zvx_node_abc123def456|Se_cr-et');
    expect(result.status).toBe(0);
  });

  it('узел, поставленный до node.env: ключ — из конфигурации пульса', () => {
    const result = preamble({
      heartbeat: 'user = "zvx_node_abc123def456:Se_cr-et"\nurl = "https://cp/node/heartbeat"\n',
    });
    expect(result.output).toContain('KEY=zvx_node_abc123def456|Se_cr-et');
    expect(result.status).toBe(0);
  });

  it('ключа на машине нет — отказ с причиной, а не узел без ключа', () => {
    const result = preamble({});
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('ключ узла на машине не найден');
  });

  /**
   * Пульс узла, как его породит установщик, с подменёнными curl и systemd-run: что он отвечает
   * на ответ площадки о версии набора и автообновлении (ADR-0068).
   */
  function heartbeat(options: { reply: string; have?: string; stamp?: number; runs?: number }) {
    const root = slash(mkdtempSync(path.join(tmpdir(), 'zvonix-beat-')));
    const etc = `${root}/etc`;
    const bin = `${root}/bin`;
    mkdirSync(etc, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const stub = (name: string, body: string): void => {
      writeFileSync(`${bin}/${name}`, `#!/bin/sh\n${body}\n`, { encoding: 'utf8', mode: 0o755 });
    };
    stub('fs_cli', 'echo "0 total."');
    stub(
      'curl',
      `echo "curl $*" >>"${root}/calls.log"\ncat >/dev/null\nprintf '%s' '${options.reply}'`,
    );
    stub('systemd-run', `echo "systemd-run $*" >>"${root}/calls.log"`);
    writeFileSync(`${etc}/heartbeat.curl`, 'url = "https://cp/node/heartbeat"\n', 'utf8');
    if (options.have !== undefined)
      writeFileSync(`${etc}/set-version`, `${options.have}\n`, 'utf8');
    if (options.stamp !== undefined)
      writeFileSync(`${etc}/auto-update.stamp`, `${String(options.stamp)}\n`, 'utf8');

    const generator = slice(
      'cat >/usr/local/sbin/zvonix-heartbeat <<HEARTBEAT',
      'chmod 0700 /usr/local/sbin/zvonix-heartbeat',
    ).replace('/usr/local/sbin/zvonix-heartbeat', `${root}/heartbeat.sh`);
    writeFileSync(
      `${root}/generate.sh`,
      [`FS_CLI='${bin}/fs_cli'`, `NODE_ETC='${etc}'`, generator].join('\n'),
      'utf8',
    );
    expect(run(`${root}/generate.sh`).status).toBe(0);

    let last = { status: -1, output: '' };
    for (let i = 0; i < (options.runs ?? 1); i += 1) {
      last = run(`${root}/heartbeat.sh`, [], {
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      });
    }
    const calls = existsSync(`${root}/calls.log`) ? readFileSync(`${root}/calls.log`, 'utf8') : '';
    return { ...last, calls };
  }

  const REPLY_NEW =
    '{"status":"online","next_heartbeat_in_ms":30000,"set_version":"aaaaaaaaaaaa","auto_update":true}';

  it('пульс: версия отстаёт и автообновление разрешено — запускает обновление отдельной единицей', () => {
    const result = heartbeat({ reply: REPLY_NEW, have: 'bbbbbbbbbbbb' });
    expect(result.status).toBe(0);
    expect(result.calls).toContain('systemd-run');
    expect(result.calls).toContain('zvonix-node-autoupdate');
    expect(result.calls).toContain('zvonix-node-update');
  });

  it('пульс: версия совпала, автообновление выключено или обновление уже пробовали недавно — не запускает', () => {
    expect(heartbeat({ reply: REPLY_NEW, have: 'aaaaaaaaaaaa' }).calls).not.toContain(
      'systemd-run',
    );
    expect(
      heartbeat({
        reply: REPLY_NEW.replace('"auto_update":true', '"auto_update":false'),
        have: 'bbbbbbbbbbbb',
      }).calls,
    ).not.toContain('systemd-run');
    // Попытка была минуту назад: повтор не раньше чем через полчаса.
    const recent = Math.floor(Date.now() / 1000) - 60;
    expect(
      heartbeat({ reply: REPLY_NEW, have: 'bbbbbbbbbbbb', stamp: recent }).calls,
    ).not.toContain('systemd-run');
  });

  it('пульс: узел без версии (старый набор) при разрешённом автообновлении обновляется', () => {
    expect(heartbeat({ reply: REPLY_NEW }).calls).toContain('systemd-run');
  });

  it('пульс: пустой ответ площадки — обновление не запускается', () => {
    const result = heartbeat({ reply: '' });
    expect(result.calls).not.toContain('systemd-run');
  });

  it('выкладка площадки обновляет узел на той же машине и не падает из-за него', () => {
    const deploy = readFileSync(
      path.join(import.meta.dirname, '..', '..', '..', '..', '..', 'deploy', 'deploy.sh'),
      'utf8',
    );
    expect(deploy).toContain('bash "$script" --update');
    // До строки DEPLOY_OK: выкладка сообщает об узле, прежде чем сказать «готово».
    expect(deploy.indexOf('update_local_node\n    first_run_hint')).toBeGreaterThan(0);
    expect(deploy).toContain('узел АТС не обновлён — площадка работает');
  });
});
