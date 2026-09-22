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

/** Подстановки, которые заполняет скрипт установки. В шаблонах они обязаны быть. */
const PLACEHOLDERS = ['@@CONTROL_PLANE@@', '@@KEY_ID@@', '@@KEY_SECRET@@'];

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

  // Шаблон без подстановок означает, что адрес или ключ вписаны намертво.
  // На узле это либо неработающая конфигурация, либо чужой секрет в репозитории.
  for (const placeholder of PLACEHOLDERS) {
    if (!content.includes(placeholder)) {
      problems.push(`${relative(file)}: нет подстановки ${placeholder}`);
    }
  }
}

// --- Скрипты, которые исполняются на серверах от root ------------------------------
//
// Установщик узла (ADR-0045) и выкладка площадки (ADR-0049). Проверка механическая:
// работают ли они, отвечает только живая машина.

const SHELL_SCRIPTS = [
  'node/install.sh',
  'deploy/deploy.sh',
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
