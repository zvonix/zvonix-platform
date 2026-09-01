import { defineConfig } from 'vitest/config';

/**
 * Интеграционные проверки (ADR-0006): модуль целиком поверх реальной PostgreSQL.
 *
 * Адрес базы — `TEST_DATABASE_URL`, по умолчанию локальная `zvonix_test`.
 * Тесты очищают схему, поэтому имя базы обязано оканчиваться на `_test` —
 * это проверяется до первого запроса.
 */
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Общая база на все файлы: параллельные наборы, роняющие и создающие схему,
    // мешали бы друг другу. Внутри файла тесты независимы и создают свои данные сами.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
