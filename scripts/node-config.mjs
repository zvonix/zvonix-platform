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
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

// --- Скрипт установки ---------------------------------------------------------

const installScript = path.join(NODE_DIR, 'install.sh');
let installScriptExists = true;
try {
  statSync(installScript);
} catch {
  problems.push('нет node/install.sh');
  installScriptExists = false;
}

// Условие именно про существование файла, а не про отсутствие проблем вообще:
// иначе сломанный XML отменял бы проверку скрипта, и о второй ошибке узнавали бы
// только после починки первой. Проверка обязана показать полную картину сразу.
if (installScriptExists) {
  const source = readFileSync(installScript, 'utf8');

  // Без этого скрипт продолжает работу после ошибки и оставляет узел настроенным
  // наполовину — а это хуже ненастроенного, потому что выглядит рабочим.
  if (!source.includes('set -euo pipefail')) {
    problems.push('node/install.sh: нет `set -euo pipefail`');
  }
  // Переводы строк только LF: скрипт исполняется на Ubuntu, а CR в шебанге
  // даёт «bad interpreter» — ошибку, по которой причина не очевидна.
  if (source.includes('\r')) {
    problems.push('node/install.sh: возврат каретки в файле, нужен только LF');
  }

  try {
    execFileSync('bash', ['-n', installScript], { stdio: 'pipe' });
  } catch (error) {
    const output =
      error instanceof Error && 'stderr' in error ? String(error.stderr) : String(error);
    problems.push(`node/install.sh: синтаксическая ошибка — ${output.trim()}`);
  }
}

if (problems.length > 0) {
  console.error(`Проблем в конфигурации узла: ${problems.length}`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`Конфигурация узла проверена: ${String(configs.length)} файлов XML и install.sh.`);
