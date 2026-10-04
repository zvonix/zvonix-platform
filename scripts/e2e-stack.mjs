/**
 * Стенд для сквозных проверок кабинета.
 *
 * Поднимает то же, что стоит в проде, и в той же топологии: **API и кабинет
 * за одним обратным прокси** ([ADR-0037](../docs/adr/0037-sessiya-v-brauzere.md)).
 * Иначе проверять было бы нечего: cookie сессии выдаётся на источник, и кабинет
 * на другом порту её просто не отправит.
 *
 * Кабинет запускается **собранным** (`next start`), а не в режиме разработки.
 * В разработке Next компилирует страницу при первом обращении, и первая проверка
 * каждого раздела ждала бы сборку — то есть измеряла бы компилятор, а не кабинет.
 *
 * Именно `next start`, а не самодостаточная сборка: та на Windows не поднимается —
 * при трассировке в неё попадают символические ссылки pnpm, и Node спотыкается
 * о них при запуске (`EPERM` на `realpath`). Проверка обязана идти одинаково
 * на машине разработчика и в CI, поэтому берётся то, что работает на обеих.
 *
 * Переписывание `/api/*` в конфигурации Next для этого не годится: там оно объявлено
 * только для разработки, а в production его нет — в проде эту работу делает прокси.
 * Здесь мы этим прокси и притворяемся.
 *
 * Написано на Node, а не на bash, по той же причине, что и `smoke.mjs`: точные
 * таймауты, управление дочерними процессами и HTTP одинаково на Windows и Ubuntu.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ENTRY = path.join(ROOT, 'apps', 'api', 'dist', 'main.js');
const WEB_DIR = path.join(ROOT, 'apps', 'web');
const NEXT_CLI = path.join(WEB_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');

const STARTUP_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://zvonix:zvonix@127.0.0.1:5432/zvonix_test';

/** Общий пароль учётных записей стенда. Стенд одноразовый и живёт в памяти прогона. */
export const E2E_PASSWORD = 'Пров3рка-Кабинета!';

/**
 * Окружение приложения на стенде — общее для API и для наполнения базы.
 *
 * **Внешние источники выключены**, как и на стенде проверок API (`harness.ts`):
 * проверка кабинета не должна зависеть ни от сети, ни от чужой доступности. Иначе первое
 * же заведение SIM определяло бы оператора в настоящем num.voxlink.ru, а воркер качал бы
 * план нумерации с сайта Минцифры.
 */
export const STACK_ENV = {
  SECRET_KEY: 'сквозная-проверка'.padEnd(32, '-'),
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  LOG_FORMAT: 'json',
  // Стенд создаёт учётные записи и данные пачкой — те самые всплески, против
  // которых заведены оба предела (ADR-0041).
  AUTH_RATE_LIMIT_ENABLED: 'false',
  WRITE_RATE_LIMIT_PER_MINUTE: '0',
  // Мессенджер без внешних вызовов (ADR-0071).
  MESSENGER_PROVIDER: 'simulated',
  OPERATOR_LOOKUP_ENABLED: 'false',
  OPERATOR_LOOKUP_URL: 'http://num.example.test/get/',
  NUMBERING_PLAN_ENABLED: 'false',
  NUMBERING_PLAN_URL: 'http://plan.example.test/DEF-9xx.csv',
};

/** Свободный порт: занимаем нулевой, узнаём номер, освобождаем. */
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

/** Ждёт, пока адрес начнёт отвечать. Падение процесса прерывает ожидание сразу. */
async function waitUntilAlive(url, child, output, expected = 200) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Процесс завершился до готовности (код ${String(child.exitCode)}).\n${output.join('')}`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.status === expected) return;
    } catch {
      // Ещё не слушает — это ожидаемо.
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `${url} не ответил за ${String(STARTUP_TIMEOUT_MS / 1000)} с.\n${output.join('')}`,
  );
}

/** Гасит процесс и ждёт завершения; не дождавшись — убивает. */
async function stop(child) {
  if (child === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
  });
  child.kill('SIGTERM');
  const finished = await Promise.race([exited.then(() => true), sleep(SHUTDOWN_TIMEOUT_MS)]);
  if (finished !== true) child.kill('SIGKILL');
}

/** Жив ли процесс — словами, которые попадут в тело отказа. */
function describe(child) {
  if (child === undefined) return 'процесс неизвестен';
  if (child.signalCode !== null) return `процесс снят сигналом ${child.signalCode}`;
  if (child.exitCode !== null) return `процесс завершился с кодом ${String(child.exitCode)}`;
  return 'процесс жив';
}

/**
 * Прокси перед кабинетом и API: `/api/*` уходит в API, остальное — в Next.
 *
 * Ровно та работа, которую в проде делает обратный прокси. Тело передаётся потоком,
 * а не собирается в память: через него пойдут и выгрузки записей.
 *
 * Каждое соединение к своим — **своё**: `agent: false`. Общий пул переживает запросы
 * и отдаёт следующему сокет, который тот, кто на другом конце, уже закрыл; отказ тогда
 * выглядит как `ECONNRESET` на первом же обращении и ничем не отличается от упавшего
 * приложения. Стенду важна повторяемость, а не переиспользование соединений к себе же.
 */
function startProxy({ port, apiPort, webPort, api, web }) {
  const server = http.createServer((request, response) => {
    const toApi = request.url !== undefined && request.url.startsWith('/api/');
    const target = toApi ? apiPort : webPort;
    const url = toApi ? request.url.slice('/api'.length) : request.url;

    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: target,
        method: request.method,
        path: url,
        headers: { ...request.headers, host: `127.0.0.1:${String(port)}` },
        agent: false,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );

    upstream.on('error', (error) => {
      // Заголовки могли уже уйти: браузер закрывает страницу посреди запроса,
      // и попытка ответить второй раз убила бы прокси вместе со всем прогоном.
      if (response.headersSent) {
        response.destroy();
        return;
      }
      // Состояние процесса здесь — половина ответа на вопрос «что случилось»: снятый
      // процесс и живой, оборвавший соединение, требуют разного разбирательства,
      // а по одному `ECONNRESET` они неразличимы.
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(
        `Стенд: не достучались до ${String(target)} (${describe(toApi ? api : web)}) — ` +
          `${request.method ?? '?'} ${url ?? '?'}: ${error.message}`,
      );
    });

    // Обрыв со стороны браузера — обычное дело: страница ушла, ответ никому не нужен.
    request.on('error', () => upstream.destroy());
    response.on('close', () => upstream.destroy());

    request.pipe(upstream);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

/**
 * Поднимает стенд целиком и возвращает адрес и способ его погасить.
 *
 * База **не** сбрасывается здесь: сброс и наполнение делает подготовка прогона,
 * и делать это на каждый запуск стенда значило бы стирать данные между файлами
 * проверок.
 */
export async function startStack() {
  const [apiPort, webPort, port] = await Promise.all([freePort(), freePort(), freePort()]);
  const output = [];
  const collect = (chunk) => output.push(String(chunk));

  const api = spawn(process.execPath, [API_ENTRY], {
    cwd: path.join(ROOT, 'apps', 'api'),
    env: {
      ...process.env,
      ...STACK_ENV,
      DATABASE_URL: TEST_DATABASE_URL,
      APP_HOST: '127.0.0.1',
      APP_PORT: String(apiPort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${String(port)}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout.on('data', collect);
  api.stderr.on('data', collect);

  const web = spawn(
    process.execPath,
    [NEXT_CLI, 'start', '--hostname', '127.0.0.1', '--port', String(webPort)],
    {
      cwd: WEB_DIR,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  web.stdout.on('data', collect);
  web.stderr.on('data', collect);

  let proxy;
  try {
    await waitUntilAlive(`http://127.0.0.1:${String(apiPort)}/health/live`, api, output);
    // Кабинет отвечает на корне перенаправлением или страницей — годится любой ответ,
    // кроме отказа соединения, поэтому ждём страницу входа.
    await waitUntilAlive(`http://127.0.0.1:${String(webPort)}/login`, web, output);
    proxy = await startProxy({ port, apiPort, webPort, api, web });
  } catch (error) {
    await Promise.all([stop(api), stop(web)]);
    throw error;
  }

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    apiUrl: `http://127.0.0.1:${String(apiPort)}`,
    output,
    async stop() {
      await new Promise((resolve) => proxy.close(resolve));
      await Promise.all([stop(api), stop(web)]);
    },
  };
}
