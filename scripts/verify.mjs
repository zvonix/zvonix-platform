/**
 * Полная проверка одной командой: `pnpm verify` (она же `pnpm check`).
 *
 * Сама проверка — `scripts/check.sh`, и CI запускает именно его. Здесь только то,
 * что нужно на машине разработчика и не нужно в CI:
 *
 * 1. **Найти bash.** В PowerShell и cmd на Windows слово `bash` открывает загрузчик
 *    WSL (`WindowsApps\bash.exe`), а не Git Bash. Без установленного дистрибутива
 *    `pnpm verify` завершалась кодом 1 раньше первого шага — замер 2026-09-22,
 *    из обычного терминала VS Code. Берётся bash из Git for Windows — тот, в котором
 *    проверка и шла всё это время ([ADR-0007](../docs/adr/0007-lokalnaya-sreda.md),
 *    «Ревизия»). Ищется через `git --exec-path`, а не по жёсткому пути: Git ставится
 *    не только в Program Files. Ветка временная и уходит вместе с переездом в WSL2.
 * 2. **База и Redis — до первого шага.** После перезагрузки машины обе выключены,
 *    и без них пять шагов из четырнадцати красные заранее. Узнавать это через
 *    пять минут, на падении тестов, незачем: соединение проверяется за секунду.
 *    В CI обе поднимает сам рабочий процесс, поэтому там этой проверки нет.
 * 3. **Строка о выпуске.** После зелёной проверки — что именно проверено и чем
 *    выпускать ([deploy/README.md](../deploy/README.md), «Выпуск»). Дерево снимается
 *    до шагов и сверяется после: правка во время десятиминутной проверки значит,
 *    что зелёный результат относится уже не к нему.
 */

import './local-env.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TEST_DATABASE_URL } from './e2e-stack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONNECT_TIMEOUT_MS = 2000;
const START_WAIT_MS = 20_000;
const LOCAL_SETUP = 'docs/adr/0007-lokalnaya-sreda.md, раздел «Ревизия»';

/** Что нужно проверке снаружи. Адреса по умолчанию — те же, что у тестов (`harness.ts`). */
const SERVICES = [
  {
    name: 'PostgreSQL',
    variable: 'TEST_DATABASE_URL',
    url: TEST_DATABASE_URL,
    defaultPort: 5432,
    start: 'VERIFY_START_POSTGRES',
    section: '«Управление локальной базой»',
  },
  {
    name: 'Redis',
    variable: 'TEST_REDIS_URL',
    url: process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/15',
    defaultPort: 6379,
    start: 'VERIFY_START_REDIS',
    section: '«Управление локальной Redis»',
  },
];

function git(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

/** Bash для `check.sh`, или `null`, если подходящего нет. */
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const execPath = git(['--exec-path']);
  if (execPath === null) return null;
  // <корень Git>/mingw64/libexec/git-core → <корень Git>/bin/bash.exe. Именно `bin`,
  // а не `usr/bin`: этот запускает оболочку с путями MSYS, без которых в ней нет
  // ни `date`, ни `grep`.
  const bash = path.join(path.resolve(execPath.trim(), '..', '..', '..'), 'bin', 'bash.exe');
  return existsSync(bash) ? bash : null;
}

/** Отвечает ли адрес: только соединение, без протокола. Для «служба не запущена» этого хватает. */
function reachable(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      done(false);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

/**
 * Служба не отвечает, а команда запуска задана (`VERIFY_START_POSTGRES` / `VERIFY_START_REDIS` в
 * `.env.verify.local`, см. `local-env.mjs`) — запускает её и ждёт ответа до двадцати секунд. После перезагрузки
 * машины обе службы выключены, и поднимать их руками перед каждой проверкой незачем.
 */
async function startIfConfigured(service, bash, host, port) {
  const command = process.env[service.start];
  if (command === undefined || command === '' || bash === null) return false;
  console.log(`${service.name} не отвечает — запускаю (${service.start}).`);
  const child = spawn(bash, ['-c', command], { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  for (let waited = 0; waited < START_WAIT_MS; waited += 1000) {
    if (await reachable(host, port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return reachable(host, port);
}

/** Строки отказа по недоступным службам; пустой список — всё отвечает. */
async function unreachableServices(bash) {
  const problems = [];
  for (const service of SERVICES) {
    let url;
    try {
      url = new URL(service.url);
    } catch {
      problems.push(`${service.name}: ${service.variable} — не адрес.`);
      continue;
    }
    // Адрес через сокет Unix (`postgresql:///zvonix?host=/run/postgresql`) проверять
    // соединением по сети бессмысленно — такой пропускается, и ответит сам шаг.
    const host = url.hostname.replace(/^\[|\]$/gu, '');
    if (host === '') continue;
    const port = url.port === '' ? service.defaultPort : Number(url.port);
    if (!(await reachable(host, port)) && !(await startIfConfigured(service, bash, host, port))) {
      // Адрес печатается без учётных данных: в нём бывает пароль.
      problems.push(
        `${service.name} не отвечает на ${host}:${String(port)} (${service.variable}). ` +
          `Как запустить — ${LOCAL_SETUP}, ${service.section}.`,
      );
    }
  }
  return problems;
}

/** Отпечаток рабочего дерева: коммит, правки и незакоммиченные файлы вместе с содержимым. */
function snapshot() {
  const head = git(['rev-parse', 'HEAD'])?.trim() ?? null;
  const hash = createHash('sha256');
  hash.update(head ?? '');
  hash.update(git(['diff', 'HEAD', '--binary']) ?? '');
  const untracked = (git(['ls-files', '--others', '--exclude-standard', '-z']) ?? '')
    .split('\0')
    .filter(Boolean);
  for (const file of untracked) {
    hash.update(`\0${file}\0`);
    try {
      hash.update(readFileSync(path.join(ROOT, file)));
    } catch {
      // Файл исчез между перечислением и чтением — это тоже изменение, и оно
      // уже учтено: имя попало в отпечаток, а содержимого нет.
    }
  }
  const dirty = (git(['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length;
  return { head, dirty, fingerprint: hash.digest('hex') };
}

/** Шаги check.sh, которые не выполнены: строки `имя|секунды|исход`. */
function skippedSteps(summaryFile) {
  if (!existsSync(summaryFile)) return null;
  return readFileSync(summaryFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((row) => row.split('|'))
    .filter(([, , outcome]) => outcome === 'НЕ ВЫПОЛНЕН')
    .map(([name]) => name);
}

/** Шаги check.sh с заданным исходом: строки `имя|секунды|исход`. */
function stepsWith(summaryFile, outcomeName) {
  if (!existsSync(summaryFile)) return [];
  return readFileSync(summaryFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((row) => row.split('|'))
    .filter(([, , outcome]) => outcome === outcomeName)
    .map(([name]) => name);
}

/**
 * Последняя строка проверки — крупно и цветом, чтобы итог не приходилось искать в таблице: зелёная — всё прошло, красная — нет.
 * С временем окончания и версией: по строке видно, к какому выпуску и когда относится результат.
 */
function printVerdict(code, summaryFile, startedAt) {
  const color = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;
  const esc = String.fromCharCode(27);
  const paint = (text, open) => (color ? `${esc}[${open}m${text}${esc}[0m` : text);
  const finished = new Date();
  const when = finished.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
  const minutes = Math.floor((finished.getTime() - startedAt) / 60_000);
  const seconds = Math.round(((finished.getTime() - startedAt) % 60_000) / 1000);
  const version = git(['describe', '--tags', '--always', '--dirty'])?.trim() ?? 'без метки';
  const commit = git(['rev-parse', '--short', 'HEAD'])?.trim() ?? '—';
  const tail = `завершено ${when}, заняло ${String(minutes)} мин ${String(seconds)} с · версия ${version} (коммит ${commit})`;
  const failed = stepsWith(summaryFile, 'ПРОВАЛ');
  const skipped = stepsWith(summaryFile, 'НЕ ВЫПОЛНЕН');

  console.log('');
  if (code === 0 && skipped.length === 0) {
    console.log(paint('✔ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ УСПЕШНО', '1;32'));
    console.log(paint(`  ${tail}`, '32'));
  } else if (code === 0) {
    console.log(paint(`⚠ Пройдено, но не выполнено: ${skipped.join(', ')}`, '1;33'));
    console.log(paint(`  ${tail}`, '33'));
  } else {
    console.log(paint('✘ ПРОВЕРКА НЕ ПРОЙДЕНА', '1;31'));
    if (failed.length > 0) console.log(paint(`  Провалены шаги: ${failed.join(', ')}`, '31'));
    console.log(paint(`  ${tail}`, '31'));
  }
}

function nextTag(previous) {
  if (previous === null) return 'v0.1.0';
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(previous);
  if (match === null) return null;
  return `v${match[1]}.${match[2]}.${String(Number(match[3]) + 1)}`;
}

function printRelease(before, after, skipped) {
  console.log('');
  if (skipped === null) {
    console.log('=== Выпуск ===');
    console.log('Итог шагов не получен — судить о готовности к выпуску не по чему.');
    return;
  }
  if (skipped.length > 0) {
    console.log('=== Выпускать рано ===');
    console.log(`Не выполнены шаги: ${skipped.join(', ')}. «Не выполнено» — не успех.`);
    return;
  }
  if (before.fingerprint !== after.fingerprint) {
    console.log('=== Выпускать рано ===');
    console.log('Файлы менялись во время проверки: зелёный итог относится не к ним. Повторите.');
    return;
  }

  const commit = after.head?.slice(0, 7) ?? '—';
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? '—';
  const previous = git(['describe', '--tags', '--abbrev=0', '--match', 'v*'])?.trim() ?? null;
  const tag = nextTag(previous);

  console.log('=== Можно выпускать ===');
  console.log(`Проверено: коммит ${commit}, ветка ${branch}.`);
  if (previous === null) {
    console.log('Выпусков ещё не было.');
  } else {
    const since = git(['rev-list', '--count', `${previous}..HEAD`])?.trim() ?? '?';
    console.log(`Прошлый выпуск: ${previous}, коммитов после него: ${since}.`);
  }
  if (after.dirty > 0) {
    console.log(
      `Незакоммиченных файлов: ${String(after.dirty)} — в выпуск они не попадут: ` +
        'архив собирается из коммита метки.',
    );
  }
  if (branch !== 'main') {
    console.log(`Ветка не main: метка на «${branch}» выпустит то, чего в main ещё нет.`);
  }
  if (tag === null) {
    console.log(`Метка ${String(previous)} не вида vX.Y.Z — следующую назовите сами.`);
    return;
  }
  console.log(`Выпуск:  git tag ${tag} && git push origin ${tag}`);
  console.log(`Сервер:  sudo zvonix-deploy ${tag}   (deploy/README.md, «Выпуск»)`);
}

async function main() {
  const bash = findBash();
  if (bash === null) {
    console.error(
      'Не найден bash для scripts/check.sh. В Windows нужен Git for Windows (Git Bash): ' +
        'загрузчик WSL из PowerShell без установленного дистрибутива проверку не запустит.',
    );
    return 1;
  }

  const problems = await unreachableServices(bash);
  if (problems.length > 0) {
    console.error('Проверка не начата: без этих служб пять шагов из четырнадцати красные заранее.');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  // Две проверки разом делят одну тестовую базу: каждая сбрасывает схему под другой — оба прогона краснеют без причины.
  const logDirForLock = path.join(ROOT, 'test-results');
  mkdirSync(logDirForLock, { recursive: true });
  const lockFile = path.join(logDirForLock, 'verify.lock');
  if (existsSync(lockFile)) {
    const other = Number(readFileSync(lockFile, 'utf8').trim());
    let alive = false;
    try {
      process.kill(other, 0);
      alive = Number.isInteger(other) && other > 0;
    } catch {
      alive = false;
    }
    if (alive) {
      console.error(
        `Проверка уже идёт (процесс ${String(other)}): две разом портят друг другу общую тестовую базу. ` +
          'Дождитесь её окончания или закройте то окно.',
      );
      return 1;
    }
  }
  writeFileSync(lockFile, String(process.pid));

  const before = snapshot();
  const startedAt = Date.now();
  const workdir = mkdtempSync(path.join(tmpdir(), 'zvonix-verify-'));
  const summaryFile = path.join(workdir, 'summary');

  // Весь вывод проверки пишется ещё и в файл: после красного итога его можно прочитать целиком, а не по прокрутке окна.
  const logDir = path.join(ROOT, 'test-results');
  mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'verify-last.log');
  const log = createWriteStream(logFile);
  const say = console.log.bind(console);
  console.log = (...args) => {
    say(...args);
    log.write(`${args.join(' ')}
`);
  };

  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(bash, [path.join('scripts', 'check.sh')], {
        cwd: ROOT,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env, CHECK_SUMMARY_FILE: summaryFile },
      });
      child.stdout.on('data', (chunk) => {
        process.stdout.write(chunk);
        log.write(chunk);
      });
      child.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
        log.write(chunk);
      });
      child.on('error', reject);
      child.on('close', (exitCode) => {
        resolve(exitCode ?? 1);
      });
    });
    if (code === 0) printRelease(before, snapshot(), skippedSteps(summaryFile));
    printVerdict(code, summaryFile, startedAt);
    say(`Полный вывод: ${path.relative(ROOT, logFile)}`);
    return code;
  } finally {
    log.end();
    console.log = say;
    rmSync(lockFile, { force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
}

// Ctrl+C получает вся группа процессов консоли, и check.sh завершится сам, досказав
// итог. Запускалка его дожидается, а не уходит первой, оставляя вывод без конца.
// Второе нажатие — выйти сразу.
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
});

process.exitCode = await main().catch((error) => {
  console.error(
    `Запуск проверки не удался: ${error instanceof Error ? error.message : String(error)}`,
  );
  return 1;
});
