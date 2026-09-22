import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './vitest.shared.config.js';

/**
 * Модульные проверки: без сети, без базы, без файлов за пределами репозитория.
 * Запускаются в любом окружении и потому годятся как быстрая обратная связь при правке.
 *
 * Интеграционные вынесены в vitest.integration.config.ts: им нужна живая PostgreSQL
 * (ADR-0006), и молча пропускать их при её отсутствии нельзя — пропущенная проверка,
 * о которой никто не знает, хуже отсутствующей.
 */
export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
});
