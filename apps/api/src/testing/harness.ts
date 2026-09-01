/**
 * Общая обвязка интеграционных проверок API.
 *
 * Поднимает то же приложение, что уезжает в production — через `buildApplication`.
 * Отдельная тестовая сборка проверяла бы не то, что выкладывается: настройка,
 * включённая только в `main.ts`, не покрыта ни одним тестом и ломается незаметно.
 *
 * Вынесено из тестовых файлов, чтобы подготовка базы и сборка приложения были описаны
 * в одном месте: два файла с собственными копиями этой логики разъезжаются на первой же
 * правке, и один из них начинает проверять другое приложение.
 */

import 'reflect-metadata';
import { sql } from 'drizzle-orm';
import { applyMigrations, createDatabase } from '@zvonix/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://zvonix:zvonix@127.0.0.1:5432/zvonix_test';

/** Тесты сносят схему целиком, поэтому имя базы обязано оканчиваться на `_test`. */
function assertTestDatabase(url = TEST_DATABASE_URL): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Отказ: имя базы «${name}» не оканчивается на _test`);
  }
}

/**
 * Задаёт окружение до того, как приложение прочитает конфигурацию.
 *
 * Вызывается на уровне модуля тестового файла, а не в `beforeAll`: `buildApplication`
 * читает конфигурацию при импорте зависимостей, и опоздать сюда — значит получить
 * отказ загрузки конфигурации вместо теста (ADR-0002).
 */
export function prepareEnvironment(overrides: Record<string, string> = {}): void {
  assertTestDatabase(TEST_DATABASE_URL);
  process.env['DATABASE_URL'] = TEST_DATABASE_URL;
  process.env['SECRET_KEY'] = 'x'.repeat(32);
  process.env['APP_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'error';
  process.env['LOG_FORMAT'] = 'json';
  // Настоящий внешний сервис в тестах не дёргаем: проверка не должна зависеть
  // ни от сети, ни от чужой доступности (ADR-0006). Заглушка на границе —
  // допустима и подставляется через переопределение адреса.
  process.env['OPERATOR_LOOKUP_ENABLED'] = 'false';
  Object.assign(process.env, overrides);
}

/** Приводит базу к состоянию сразу после миграций. Каждый прогон начинается с чистого. */
export async function resetDatabase(url = TEST_DATABASE_URL): Promise<void> {
  assertTestDatabase(url);
  // Без предела времени: создание индексов на пустой базе быстрое, но общий предел
  // пула на миграции распространяться не должен.
  const handle = createDatabase({ url, poolMax: 1, statementTimeoutMs: 0 });
  try {
    await handle.db.execute(sql`drop schema if exists public cascade`);
    await handle.db.execute(sql`create schema public`);
    await handle.db.execute(sql`drop schema if exists drizzle cascade`);
    await applyMigrations(handle.db);
  } finally {
    await handle.close();
  }
}

/** Разовый запрос к базе мимо приложения: подготовка данных и проверка последствий. */
export async function withDatabase<T>(
  work: (execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }>) => Promise<T>,
  url = TEST_DATABASE_URL,
): Promise<T> {
  const handle = createDatabase({ url, poolMax: 1 });
  try {
    return await work((query) => handle.db.execute(query));
  } finally {
    await handle.close();
  }
}

/** Поднимает приложение целиком и доводит Fastify до готовности принимать запросы. */
export async function startApi(): Promise<NestFastifyApplication> {
  const { buildApplication } = await import('../bootstrap.js');
  const { app } = await buildApplication();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

let counter = 0;

/** Уникальный адрес: тесты не должны зависеть от порядка запуска и друг от друга. */
export function uniqueEmail(): string {
  counter += 1;
  return `user${String(counter)}.${String(Date.now())}@example.test`;
}

export const TEST_PASSWORD = 'достаточно длинный пароль';
