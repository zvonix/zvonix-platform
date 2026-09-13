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
import type { TelephonyRepository } from '../modules/telephony/telephony.repository.js';

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://zvonix:zvonix@127.0.0.1:5432/zvonix_test';

/** База 15: проверки очищают её целиком, поэтому рабочая не годится (ADR-0007). */
const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/15';

/** Тесты сносят схему целиком, поэтому имя базы обязано оканчиваться на `_test`. */
function assertTestDatabase(url = TEST_DATABASE_URL): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Отказ: имя базы «${name}» не оканчивается на _test`);
  }
}

/**
 * Полный набор окружения проверок.
 *
 * Именно **полный**, а не «то, что важно»: переменная, оставленная без значения,
 * достаётся файлу от соседа, если процесс общий. Так и было — набор, запущенный
 * в одном процессе, ломался из-за `REDIS_URL`, подменённого предыдущим файлом.
 * Здесь перечислено всё, что тестовые файлы переопределяют, и всё это возвращается
 * к умолчанию перед каждым файлом.
 */
const BASELINE: Record<string, string> = {
  SECRET_KEY: 'x'.repeat(32),
  APP_ENV: 'test',
  LOG_LEVEL: 'error',
  LOG_FORMAT: 'json',
  REDIS_URL: TEST_REDIS_URL,
  SIP_REALM: 'sip.zvonix.test',
  // Разработка идёт без TLS, и cookie сессии выдаётся незащищённой (ADR-0037).
  // Задано явно, а не оставлено на умолчание: от этого значения зависит имя
  // cookie, и молчаливая смена умолчания сломала бы проверки не там, где искать.
  PUBLIC_BASE_URL: 'http://127.0.0.1:8000',
  // Настоящий внешний сервис в тестах не дёргаем: проверка не должна зависеть
  // ни от сети, ни от чужой доступности (ADR-0006). Заглушка на границе —
  // допустима и подставляется через переопределение адреса.
  OPERATOR_LOOKUP_ENABLED: 'false',
  OPERATOR_LOOKUP_URL: 'http://num.example.test/get/',
  // Проверки создают десятки учётных записей с одного адреса — с включённым
  // ограничением они упирались бы в предел, задуманный против перебора, а не против них.
  // Сам механизм проверяется отдельным набором, который включает его обратно.
  AUTH_RATE_LIMIT_ENABLED: 'false',
  // По той же причине снят и предел изменений (ADR-0041): подготовка одной проверки —
  // это десятки записей одним администратором за секунды, то есть ровно тот всплеск,
  // против которого предел и заведён. Сам механизм проверяется отдельным набором,
  // который включает его обратно переопределением.
  WRITE_RATE_LIMIT_PER_MINUTE: '0',
  // Предел на собственное оборудование партнёра (ADR-0043) занижен намеренно: с боевыми
  // пятьюдесятью проверка упиралась бы в него полусотней запросов, а с нулём не проверяла
  // бы вовсе. Двенадцать — выше всего, что заводит любая отдельная проверка, и достижимо
  // за десяток обращений.
  PARTNER_GATEWAY_LIMIT: '12',
  // Скачивать три мегабайта плана нумерации ради прогона проверок незачем: сам разбор
  // проверяется на куске настоящего файла, а загрузка — на подставленном источнике.
  NUMBERING_PLAN_ENABLED: 'false',
  NUMBERING_PLAN_URL: 'http://plan.example.test/DEF-9xx.csv',
};

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
  Object.assign(process.env, BASELINE, overrides);
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

/**
 * Отмечает шлюз зарегистрированным на узле — тем же путём, каким это делает FreeSWITCH.
 *
 * Маршрутизация выбирает только те шлюзы, что зарегистрированы **на принявшем вызов
 * узле**: диалплан набирает их как зарегистрированных пользователей, и с чужого узла
 * такой записи не существует. Пока проверка этого шага не делала, она выбирала
 * оборудование, которого на узле нет, — то есть проверяла не то, что происходит.
 *
 * Идёт через настоящий обработчик каталога, а не записью в базу: так проверяется заодно
 * и то, что шлюз вообще допущен к регистрации.
 *
 * Имя учётной записи читается из репозитория приложения, а не спрашивается у теста:
 * иначе каждый вызов пришлось бы сопровождать разбором ответа о заведении шлюза,
 * а забытый разбор молча вернул бы прежнее поведение.
 */
export async function registerGateway(
  app: NestFastifyApplication,
  nodeKey: string,
  gatewayId: string,
): Promise<void> {
  const { TelephonyRepository } = await import('../modules/telephony/telephony.repository.js');
  const gateway = await app
    .get(TelephonyRepository)
    .findGateway(gatewayId as Parameters<TelephonyRepository['findGateway']>[0]);
  if (gateway === undefined) throw new Error(`Шлюз ${gatewayId} не найден`);

  const response = await app.inject({
    method: 'POST',
    url: '/node/directory',
    headers: {
      authorization: `Bearer ${nodeKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `section=directory&user=${gateway.sipUsername}&action=sip_auth`,
  });

  // Каталог отвечает всегда `200` и всегда XML: «записи нет» — тоже документ.
  // Отличить регистрацию от отказа можно только по содержимому.
  if (!response.body.includes('a1-hash')) {
    throw new Error(`Шлюз ${gateway.sipUsername} не принят каталогом`);
  }
}
