/**
 * Точка входа API.
 *
 * `reflect-metadata` импортируется первым: контейнер NestJS читает типы параметров
 * конструктора из метаданных, а их поддержка появляется только после этого импорта.
 */

import 'reflect-metadata';
import { buildApplication } from './bootstrap.js';

async function main(): Promise<void> {
  const { app, config, logger } = await buildApplication();

  await app.listen({ host: config.APP_HOST, port: config.APP_PORT });
  logger.info('API запущен', { host: config.APP_HOST, port: config.APP_PORT });
}

try {
  await main();
} catch (cause) {
  // Логгера на этом этапе может не быть: упасть могла как раз загрузка конфигурации,
  // из которой он и создаётся. Поэтому пишем в поток напрямую.
  process.stderr.write(`Не удалось запустить API: ${String(cause)}\n`);
  process.exitCode = 1;
}
