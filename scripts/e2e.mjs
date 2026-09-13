/**
 * Сквозные проверки кабинета: подготовка, прогон, уборка.
 *
 * Порядок обязателен и потому собран в одном месте, а не размазан по настройке
 * Playwright: база приводится к чистому виду, наполняется стендом, поднимается
 * приложение, и только после этого запускается браузер.
 *
 * Отдельным запускающим скриптом, а не через `globalSetup`, по одной причине:
 * адрес стенда известен только после его подъёма (порты выбираются свободные),
 * а настройка Playwright читается **до** подготовки. Здесь адрес просто передаётся
 * дочернему процессу окружением.
 *
 * Код возврата 78 означает «проверка не выполнена», а не «провалена»: браузера
 * может не быть на машине, и это не то же самое, что упавший кабинет
 * (`scripts/check.sh`, `step_optional`).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { E2E_PASSWORD, startStack, TEST_DATABASE_URL } from './e2e-stack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Код «не выполнено»: у шага проверки три исхода, и это третий. */
const NOT_RUN = 78;

/** Запускает команду и отдаёт её код возврата вместе с выводом. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    const output = [];
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    child.stderr?.on('data', (chunk) => output.push(String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output: output.join('') });
    });
  });
}

/**
 * Есть ли браузер, которым проверять.
 *
 * Проверяется попыткой его запустить, а не наличием каталога и не выводом
 * `install --dry-run`: тот печатает путь установки независимо от того, лежит ли
 * там что-нибудь, и «проверка» по нему всегда отвечала бы «есть». Запуск отвечает
 * на настоящий вопрос — сможем ли мы открыть страницу.
 */
async function browserReady() {
  try {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await browserReady())) {
    process.stdout.write(
      'Браузер Playwright не установлен — сквозные проверки кабинета пропущены.\n' +
        'Поставить: pnpm exec playwright install chromium\n',
    );
    process.exitCode = NOT_RUN;
    return;
  }

  // База приводится к чистому виду тем же процессом, что её наполняет: сброс требует
  // пакета базы, а корень монорепозитория его не зависимость.
  process.stdout.write('Готовим базу и наполняем стенд…\n');
  const seeded = await run(process.execPath, [path.join('dist', 'testing', 'seed-e2e.js')], {
    cwd: path.join(ROOT, 'apps', 'api'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, ...stackEnv() },
  });
  if (seeded.code !== 0) {
    process.stderr.write(`Наполнение стенда не удалось:\n${seeded.output}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('Поднимаем кабинет и API…\n');
  const stack = await startStack();

  try {
    const result = await run(
      process.execPath,
      [path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'), 'test'],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, E2E_BASE_URL: stack.baseUrl, E2E_PASSWORD },
      },
    );
    if (result.code !== 0) {
      // Код называется числом: у упавшей проверки он равен единице, а у снятого
      // процесса — коду сигнала. Это разные события, и различать их по молчанию
      // нельзя.
      process.stderr.write(`\nPlaywright завершился с кодом ${String(result.code)}.\n`);
      process.stderr.write(`Вывод стенда:\n${stack.output.join('')}\n`);
      process.exitCode = result.code;
    }
  } finally {
    await stack.stop();
  }
}

/** Конфигурация, без которой приложение не поднимется вовсе (ADR-0002). */
function stackEnv() {
  return {
    SECRET_KEY: 'сквозная-проверка'.padEnd(32, '-'),
    APP_ENV: 'test',
    LOG_LEVEL: 'error',
    LOG_FORMAT: 'json',
    AUTH_RATE_LIMIT_ENABLED: 'false',
    WRITE_RATE_LIMIT_PER_MINUTE: '0',
  };
}

// Исключение здесь — тоже исход проверки, и он обязан быть назван. Без своей
// обработки оно ушло бы в необработанное отклонение: код возврата тот же, а причина
// печаталась бы стеком, без единого слова о том, на каком шаге проверка стояла.
await main().catch((error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`\nСквозные проверки прерваны: ${detail}\n`);
  process.exitCode = 1;
});
