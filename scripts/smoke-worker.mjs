/**
 * Смоук собранного фонового процесса (ADR-0020).
 *
 * Отвечает на вопрос, который не закрывает ни один другой шаг: **запускается ли то,
 * что мы собрали, и гаснет ли оно по сигналу.** Интеграционные проверки поднимают
 * контейнер из исходников; здесь запускается `dist` отдельным процессом, с настоящими
 * сокетами до PostgreSQL и Redis.
 *
 * Проверяется три вещи, и каждая ловит свой отказ:
 *   1. процесс поднимается и заводит расписание — иначе уборка не выполняется вовсе;
 *   2. по SIGTERM он гаснет сам, а не по таймауту — иначе проход, убитый посреди
 *      удаления записи, оставит объект в хранилище без отметки в базе;
 *   3. при недоступном Redis он **падает**, а не висит — процесс, который выглядит
 *      работающим и ничего не делает, хуже упавшего: его никто не чинит.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'apps', 'worker', 'dist', 'main.js');

/** Сколько ждём запуска: холодный старт с подключением к базе и Redis. */
const STARTUP_TIMEOUT_MS = 60_000;
/** Сколько ждём завершения после сигнала. Дальше — считаем, что не гасится. */
const SHUTDOWN_TIMEOUT_MS = 15_000;
/** Сколько ждём падения при недоступном Redis. Больше — значит висит. */
const FAILURE_TIMEOUT_MS = 30_000;

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://zvonix:zvonix@127.0.0.1:5432/zvonix_test';
const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/15';

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Свободный порт: занимаем нулевой, узнаём выданный номер, освобождаем. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Не удалось определить свободный порт'));
        });
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

function launch(redisUrl) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: path.join(ROOT, 'apps', 'worker'),
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: redisUrl,
      // Конфигурация обязана быть полной: процесс с неполной не поднимается (ADR-0002).
      SECRET_KEY: 'смоук'.padEnd(32, '-'),
      APP_ENV: 'test',
      // Смоук проверяет запуск, а не загрузку справочников: расписание заводит первый
      // проход сразу, и без этого воркер полез бы в сеть за планом нумерации.
      NUMBERING_PLAN_ENABLED: 'false',
      LOG_LEVEL: 'info',
      LOG_FORMAT: 'json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  return { child, output };
}

/** Ждёт строку в выводе процесса. Падение процесса прерывает ожидание. */
async function waitForOutput(child, output, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output.join('').includes(needle)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Процесс завершился до готовности (код ${String(child.exitCode)}).\n${output.join('')}`,
      );
    }
    await sleep(100);
  }
  throw new Error(`Не дождались «${needle}» за ${String(timeoutMs / 1000)} с.\n${output.join('')}`);
}

/** Гасит процесс и ждёт его завершения. Возвращает `true`, если завершился сам. */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  const exited = new Promise((resolve) => {
    child.once('exit', () => {
      resolve(true);
    });
  });

  child.kill('SIGTERM');
  const stopped = await Promise.race([exited, sleep(SHUTDOWN_TIMEOUT_MS).then(() => false)]);
  if (!stopped) child.kill('SIGKILL');
  return stopped;
}

/** Ждёт завершения процесса и возвращает код возврата, либо `undefined` по таймауту. */
async function waitForExit(child, timeoutMs) {
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => {
      resolve(code ?? 1);
    });
  });
  return Promise.race([exited, sleep(timeoutMs).then(() => undefined)]);
}

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed });
  const mark = passed ? 'ok' : 'ПРОВАЛ';
  process.stdout.write(`  ${mark.padEnd(6)} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
}

async function main() {
  const { child, output } = launch(TEST_REDIS_URL);
  try {
    await waitForOutput(child, output, 'Расписание фоновых задач запущено', STARTUP_TIMEOUT_MS);
    check('собранный воркер поднялся и завёл расписание', true);

    check(
      'в расписании все проходы',
      [
        'reservations.release-expired',
        'calls.close-without-cdr',
        'nodes.retire-silent',
        'recordings.remove-expired',
        'sessions.purge-expired',
        'limits.purge-closed-windows',
        'quality.suspend-over-threshold',
        'resolutions.refresh-stale',
        'numbering-plan.refresh',
        'mail.deliver-due',
        'mail.purge-sent',
        'auth-tokens.purge-expired',
      ].every((task) => output.join('').includes(task)),
    );

    const stoppedItself = await stop(child);
    check('процесс гаснет по сигналу, а не по таймауту', stoppedItself);
  } catch (cause) {
    check('запуск собранного воркера', false, String(cause));
    await stop(child);
  }

  // Недоступный Redis: адрес свободного порта, где никто не слушает.
  const deadPort = await freePort();
  const dead = launch(`redis://127.0.0.1:${String(deadPort)}/0`);
  const code = await waitForExit(dead.child, FAILURE_TIMEOUT_MS);
  if (code === undefined) {
    await stop(dead.child);
    check('при недоступном Redis воркер падает, а не висит', false, 'процесс не завершился');
  } else {
    check(
      'при недоступном Redis воркер падает, а не висит',
      code !== 0,
      `код возврата ${String(code)}`,
    );
  }

  const failed = checks.filter((item) => !item.passed);
  if (failed.length > 0) {
    process.stdout.write(`\nПровалено проверок смоука воркера: ${String(failed.length)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nСмоук воркера пройден: ${String(checks.length)} проверок.\n`);
}

await main();
