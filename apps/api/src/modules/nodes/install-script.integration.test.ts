/**
 * Раздача установщика узла ([ADR-0045](../../../../../docs/adr/0045-ustanovshchik-uzla.md)).
 *
 * Проверяется то, из-за чего установка не работала вовсе: отдаётся ли скрипт по адресу,
 * который называет панель, собирается ли он целиком и **остаётся ли он при этом
 * исполнимым**. Последнее не очевидно: внутрь вкладывается XML, и ошибка в сборке
 * даст синтаксически битый скрипт, который выяснится на живой машине.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    const end = script.indexOf('# Прежний каталог не удаляется');
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
