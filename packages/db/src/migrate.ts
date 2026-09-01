/**
 * Применение миграций (ADR-0005).
 *
 * Отдельная команда, а не автозапуск при старте приложения. При автозапуске несколько
 * экземпляров API, поднятых одновременно, начинают мигрировать схему параллельно,
 * а откатить неудачную миграцию посреди выкладки уже нечем. Миграции — шаг выкладки.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase, type Database } from './client.js';

/** Каталог с миграциями. Разрешается от этого файла, а не от рабочего каталога процесса. */
export const MIGRATIONS_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/** Применяет непринятые миграции к переданному подключению. */
export async function applyMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * Точка входа команды `pnpm db:migrate`.
 *
 * Читает `DATABASE_URL` напрямую, а не через `@zvonix/config`: миграции запускаются
 * и в окружениях, где заданы не все переменные приложения — например, в задании выкладки,
 * которому не нужен ни `SECRET_KEY`, ни настройки логов.
 */
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    process.stderr.write('Не задана переменная DATABASE_URL\n');
    process.exitCode = 1;
    return;
  }

  const handle = createDatabase({
    // Одно соединение: миграции выполняются последовательно, пул здесь только мешал бы
    // диагностике при зависшей блокировке.
    poolMax: 1,
    // Без предела времени: создание индекса на большой таблице идёт минутами,
    // и обычный `statement_timeout` убил бы выкладку на середине.
    statementTimeoutMs: 0,
    url,
  });
  try {
    await applyMigrations(handle.db);
    process.stdout.write('Миграции применены\n');
  } catch (cause) {
    process.stderr.write(`Миграции не применены: ${String(cause)}\n`);
    process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

// Запуск только когда файл вызван как команда, а не импортирован тестом.
// Сравнение через pathToFileURL, а не склейкой строки: на Windows путь начинается
// с буквы диска и обратных слэшей, и склеенный `file://D:\...` никогда не совпадёт.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  await main();
}
