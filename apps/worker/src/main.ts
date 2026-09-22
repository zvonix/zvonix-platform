/**
 * Точка входа фонового процесса (ADR-0020).
 *
 * `reflect-metadata` импортируется первым: контейнер NestJS читает типы параметров
 * конструктора из метаданных, а их поддержка появляется только после этого импорта.
 */

import 'reflect-metadata';
import { buildWorker, verifyRedis } from './bootstrap.js';

async function main(): Promise<void> {
  const { context, scheduler, config, logger } = await buildWorker();

  try {
    await verifyRedis(config, logger);
    await scheduler.start();
  } catch (cause) {
    // Расписание не поднялось — держать процесс с подключённой базой и пустой очередью
    // незачем: он выглядел бы работающим, ничего не выполняя.
    await context.close();
    throw cause;
  }

  logger.info('Воркер запущен');
}

try {
  await main();
} catch (cause) {
  // Логгера на этом этапе может не быть: упасть могла как раз загрузка конфигурации,
  // из которой он и создаётся. Поэтому пишем в поток напрямую.
  process.stderr.write(`Не удалось запустить воркер: ${String(cause)}\n`);
  process.exitCode = 1;
}
