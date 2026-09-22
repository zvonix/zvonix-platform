/**
 * Снимки экранов кабинета — `pnpm ui:screens` (`scripts/ui-screens.mjs`).
 *
 * Отдельно от `playwright.config.ts`: там проверяется, оживает ли кабинет, и прогон входит
 * в гейт; здесь — как он выглядит, и прогон в гейт не входит. Файлы этого обхода названы
 * `*.screens.ts` и `*.setup.ts`, чтобы основная настройка (`*.spec.ts`) их не подбирала.
 *
 * Эталоны лежат вне git, в `.ui-baseline/<система>/`: снимок зависит от шрифтов и системы,
 * и эталон с Windows на Ubuntu не совпадёт ни одним пикселем. Пишутся **только явным
 * `--update-snapshots`**: снятый молча эталон узаконил бы то, что на экране сейчас,
 * даже если это поломка.
 */

import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'];

export default defineConfig({
  testDir: './e2e/screens',
  outputDir: 'test-results/ui-screens',
  snapshotPathTemplate: '.ui-baseline/{platform}/{arg}{ext}',
  updateSnapshots: 'none',
  // Стенд общий, и находки пишутся в один файл по порядку: параллельность купила бы
  // минуту и продала повторяемость — как в основной настройке.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // Один тест — все разделы роли на одной ширине в одной теме.
  timeout: 240_000,
  expect: {
    timeout: 10_000,
    // Ни одного пикселя сверх порога цвета (по умолчанию 0,2 — он и поглощает сглаживание).
    // Замер 2026-09-22 на Windows: два прогона без правок, 104 снимка каждый, — расхождений
    // ноль; подменённый эталон пойман. Запас в 150 пикселей, взятый сначала, шума не гасил,
    // а смену одной цифры в сумме мог бы скрыть. Появится шум — поднять по замеру, не на глаз.
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 },
  },
  reporter: [['list']],
  use: {
    ...(baseURL === undefined ? {} : { baseURL }),
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /\.setup\.ts$/u, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'screens',
      testMatch: /\.screens\.ts$/u,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
