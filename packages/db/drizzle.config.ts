/**
 * Настройки drizzle-kit.
 *
 * `casing` берётся из общей константы, а не пишется здесь строкой: то же значение
 * нужно рантайму в client.ts, и разойтись эти два места не должны (см. ADR-0016).
 */

import { defineConfig } from 'drizzle-kit';
import { CASING } from './src/casing.js';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  casing: CASING,
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  // `push` не используется ни при каких условиях: он меняет схему в обход файлов
  // миграций, а ADR-0005 запрещает расхождение схемы со списком применённых миграций.
  strict: true,
  verbose: true,
});
