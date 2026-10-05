/**
 * Точка входа API.
 *
 * `reflect-metadata` импортируется первым: контейнер NestJS читает типы параметров
 * конструктора из метаданных, а их поддержка появляется только после этого импорта.
 */

import 'reflect-metadata';
import { buildApplication } from './bootstrap.js';
import { SmppServer } from './modules/messaging/smpp/server.js';

async function main(): Promise<void> {
  const { app, config, logger } = await buildApplication();

  await app.listen({ host: config.APP_HOST, port: config.APP_PORT });
  // Только здесь, а не в модуле: воркер подключает тот же модуль и не должен занимать порт SMPP.
  // SMPP необязателен: занятый порт или нет файлов сертификата не должны класть API с голосом.
  try {
    await app.get(SmppServer).start();
  } catch (cause) {
    logger.error('SMPP не запущен', cause);
  }
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
