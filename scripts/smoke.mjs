/**
 * Смоук собранного приложения.
 *
 * Отвечает на вопрос, который не закрывает ни один другой шаг проверки:
 * **запускается ли то, что мы собрали.** Формат, линтер, типы и тесты могут быть
 * зелёными у приложения, которое не поднимается вовсе — именно так и случилось
 * с метаданными декораторов (ADR-0017): типы сходились, тесты проходили,
 * а процесс падал на сборке контейнера зависимостей.
 *
 * Проверяет собранный `dist`, а не исходники, и ходит по настоящему сокету,
 * а не через `inject`: это единственный шаг, где участвует всё сразу —
 * загрузка модулей Node, чтение конфигурации, подключение к базе, слушающий порт.
 *
 * Написан на Node, а не на bash: нужны точные таймауты, управление дочерним
 * процессом и HTTP-запросы одинаково на Windows и Ubuntu, а `curl` и способы
 * убить процесс на этих системах различаются.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'apps', 'api', 'dist', 'main.js');

/** Сколько ждём, пока приложение начнёт отвечать. Холодный старт с подключением к базе. */
const STARTUP_TIMEOUT_MS = 60_000;
/** Сколько ждём завершения после сигнала. Дальше — считаем, что не гасится. */
const SHUTDOWN_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://zvonix:zvonix@127.0.0.1:5432/zvonix_test';

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

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Один запрос с собственным таймаутом: зависший сокет не должен вешать проверку. */
async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 5000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { status: response.status, body: await response.text(), headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** Ждёт, пока приложение ответит на проверку живости. Падение процесса прерывает ожидание. */
async function waitUntilAlive(base, child, output) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Процесс завершился до готовности (код ${String(child.exitCode)}).\n${output.join('')}`,
      );
    }
    try {
      const response = await request(`${base}/health/live`);
      if (response.status === 200) return;
    } catch {
      // Ещё не слушает — это ожидаемо, пробуем снова.
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Приложение не ответило за ${String(STARTUP_TIMEOUT_MS / 1000)} с.\n${output.join('')}`,
  );
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
  const result = await Promise.race([exited, sleep(SHUTDOWN_TIMEOUT_MS).then(() => false)]);

  if (!result) child.kill('SIGKILL');
  return result;
}

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  const mark = passed ? 'ok' : 'ПРОВАЛ';
  process.stdout.write(`  ${mark.padEnd(6)} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;

  const child = spawn(process.execPath, [ENTRY], {
    cwd: path.join(ROOT, 'apps', 'api'),
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      // Значение не используется в этом сценарии, но конфигурация обязана быть полной:
      // приложение с неполной конфигурацией не поднимается (ADR-0002).
      SECRET_KEY: 'смоук'.padEnd(32, '-'),
      APP_ENV: 'test',
      APP_HOST: '127.0.0.1',
      APP_PORT: String(port),
      LOG_LEVEL: 'error',
      LOG_FORMAT: 'json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  /** Вывод процесса копится, чтобы показать его при неудаче. */
  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));

  try {
    await waitUntilAlive(base, child, output);
    check('собранное приложение поднялось и слушает порт', true);

    const ready = await request(`${base}/health/ready`);
    check(
      'готовность подтверждает подключение к базе',
      ready.status === 200,
      `HTTP ${String(ready.status)}`,
    );

    const protectedRoute = await request(`${base}/auth/me`);
    check(
      'закрытый обработчик отвечает 401 без токена',
      protectedRoute.status === 401,
      `HTTP ${String(protectedRoute.status)}`,
    );

    check(
      'ответ несёт сквозной идентификатор запроса',
      typeof protectedRoute.headers.get('x-correlation-id') === 'string',
    );

    const missing = await request(`${base}/такого-маршрута-нет`);
    check(
      'несуществующий маршрут отвечает 404 в общем виде ошибки',
      missing.status === 404 && missing.body.includes('"not_found"'),
      `HTTP ${String(missing.status)}`,
    );

    const stoppedItself = await stop(child);
    check('процесс завершается по сигналу, а не по таймауту', stoppedItself);
  } catch (cause) {
    check('запуск собранного приложения', false, String(cause));
    await stop(child);
  }

  const failed = checks.filter((item) => !item.passed);
  if (failed.length > 0) {
    process.stdout.write(`\nПровалено проверок смоука: ${String(failed.length)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nСмоук пройден: ${String(checks.length)} проверок.\n`);
}

await main();
