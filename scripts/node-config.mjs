/**
 * Проверка конфигурации узла АТС.
 *
 * Файлы в `node/` уезжают на живое оборудование и там же впервые проверяются на деле.
 * До этого момента можно убедиться хотя бы в механическом: XML разбирается, скрипт
 * установки синтаксически верен, а подстановки не забыты.
 *
 * Проверять это в CI важнее обычного: невалидный `xml_curl.conf.xml` FreeSWITCH
 * отбрасывает молча — узел просто не спрашивает маршрут, и причина не видна ниоткуда.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SyntaxValidator } from 'fast-xml-validator';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE_DIR = path.join(ROOT, 'node');

/**
 * Подстановки, которые заполняет скрипт установки, — по файлам. Файл связи с площадкой
 * без адреса или ключа означает, что они вписаны намертво: на узле это неработающая
 * конфигурация либо чужой секрет в репозитории.
 */
const PLACEHOLDERS = {
  'autoload_configs/xml_curl.conf.xml': ['@@CONTROL_PLANE@@', '@@KEY_ID@@', '@@KEY_SECRET@@'],
  'autoload_configs/json_cdr.conf.xml': ['@@CONTROL_PLANE@@', '@@KEY_ID@@', '@@KEY_SECRET@@'],
  'vars.xml': ['@@SIP_REALM@@'],
  'autoload_configs/event_socket.conf.xml': ['@@ESL_PASSWORD@@'],
};

/**
 * Чего в наборе быть не должно (ADR-0051). Каждое — то, через что 2026-09-22 на узел
 * входили сканеры, пока на нём лежала штатная конфигурация.
 */
const FORBIDDEN = [
  [/<user\s/u, 'учётная запись в статическом каталоге — учётные записи даёт только площадка'],
  // По значению, а не по слову: комментарии набора называют эти пароли, объясняя запрет.
  [/data="default_password=/u, 'штатный пароль пользователей'],
  [/value="ClueCon"/u, 'штатный пароль ESL'],
  [/name="listen-ip"\s+value="(?!127\.0\.0\.1")/u, 'ESL слушает не только 127.0.0.1'],
  [/name="auth-calls"\s+value="false"/u, 'вызовы без проверки пароля'],
  [/name="accept-blind-(reg|auth)"\s+value="true"/u, 'регистрация без проверки пароля'],
];

const problems = [];

function xmlFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) xmlFiles(full, found);
    else if (entry.name.endsWith('.xml')) found.push(full);
  }
  return found;
}

const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

// --- Конфигурация FreeSWITCH --------------------------------------------------

const configs = xmlFiles(NODE_DIR);
if (configs.length === 0) {
  problems.push('в node/ нет ни одного файла конфигурации');
}

for (const file of configs) {
  const content = readFileSync(file, 'utf8');

  try {
    SyntaxValidator.validate(content);
  } catch (error) {
    problems.push(
      `${relative(file)}: XML не разбирается — ${error instanceof Error ? error.message : String(error)}`,
    );
    continue;
  }

  const name = path.relative(path.join(NODE_DIR, 'conf'), file).split(path.sep).join('/');
  for (const placeholder of PLACEHOLDERS[name] ?? []) {
    if (!content.includes(placeholder)) {
      problems.push(`${relative(file)}: нет подстановки ${placeholder}`);
    }
  }
  for (const [pattern, meaning] of FORBIDDEN) {
    if (pattern.test(content)) problems.push(`${relative(file)}: ${meaning}`);
  }
}

// Набор без обязательного файла — это узел на штатном файле вместо нашего.
for (const name of Object.keys(PLACEHOLDERS)) {
  if (!configs.some((file) => file === path.join(NODE_DIR, 'conf', name))) {
    problems.push(`node/conf/${name}: нет файла`);
  }
}

// --- Скрипты, которые исполняются на серверах от root ------------------------------
//
// Установщик узла (ADR-0045) и выкладка площадки (ADR-0049). Проверка механическая:
// работают ли они, отвечает только живая машина.

const SHELL_SCRIPTS = [
  'node/install.sh',
  'node/build-freeswitch.sh',
  'deploy/deploy.sh',
  'deploy/backup.sh',
  'deploy/server-setup.sh',
  'deploy/install.sh',
];

// Каждый скрипт проверяется независимо от остальных и от XML: сломанный файл не отменяет
// проверку соседнего, иначе о второй ошибке узнавали бы только после починки первой.
for (const script of SHELL_SCRIPTS) {
  const file = path.join(ROOT, script);
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    problems.push(`нет ${script}`);
    continue;
  }

  // Без этого скрипт продолжает работу после ошибки и оставляет сервер настроенным
  // наполовину — а это хуже ненастроенного, потому что выглядит рабочим.
  if (!source.includes('set -euo pipefail')) {
    problems.push(`${script}: нет \`set -euo pipefail\``);
  }
  // Переводы строк только LF: скрипт исполняется на Ubuntu, а CR в шебанге
  // даёт «bad interpreter» — ошибку, по которой причина не очевидна.
  if (source.includes('\r')) {
    problems.push(`${script}: возврат каретки в файле, нужен только LF`);
  }

  try {
    execFileSync('bash', ['-n', file], { stdio: 'pipe' });
  } catch (error) {
    const output =
      error instanceof Error && 'stderr' in error ? String(error.stderr) : String(error);
    problems.push(`${script}: синтаксическая ошибка — ${output.trim()}`);
  }
}

if (problems.length > 0) {
  console.error(`Проблем в конфигурации узла и выкладки: ${problems.length}`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(
  `Конфигурация узла и выкладки проверена: ${String(configs.length)} файлов XML, ` +
    `${String(SHELL_SCRIPTS.length)} скрипта.`,
);
