import { fileURLToPath } from 'node:url';

/**
 * Псевдонимы рабочих пакетов на исходники.
 *
 * Наружу пакеты отдают собранный `dist` (ADR-0017) — так их видит и приложение,
 * и Node. Тестам он не годится: сборка отстаёт от только что изменённого файла,
 * и тест зелёный, потому что проверил прошлую версию кода. Это худший вид зелёного
 * теста, поэтому здесь и только здесь пакеты читаются из `src`.
 */
export const workspaceAliases = {
  '@zvonix/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
  '@zvonix/config': fileURLToPath(new URL('./packages/config/src/index.ts', import.meta.url)),
  '@zvonix/logger': fileURLToPath(new URL('./packages/logger/src/index.ts', import.meta.url)),
  '@zvonix/db/schema': fileURLToPath(new URL('./packages/db/src/schema/index.ts', import.meta.url)),
  '@zvonix/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
};
