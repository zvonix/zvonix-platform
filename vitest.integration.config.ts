import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './vitest.shared.config.js';

/**
 * Интеграционные проверки (ADR-0006): модуль целиком поверх реальной PostgreSQL.
 *
 * Адрес базы — `TEST_DATABASE_URL`, по умолчанию локальная `zvonix_test`.
 * Тесты очищают схему, поэтому имя базы обязано оканчиваться на `_test` —
 * это проверяется до первого запроса.
 *
 * Транспиляция здесь идёт через SWC, а не через штатный esbuild: esbuild не генерирует
 * метаданные декораторов, а контейнер NestJS по ним определяет, что подставить
 * в конструктор. Без них приложение не поднимается вовсе — и проверялось бы
 * не приложение, а способность теста обойти его сборку.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { alias: workspaceAliases },
  test: {
    include: ['{apps,packages}/*/src/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Общая база на все файлы: параллельные наборы, роняющие и создающие схему,
    // мешали бы друг другу. Внутри файла тесты независимы и создают свои данные сами.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
