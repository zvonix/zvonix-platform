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
import { sql, type SQL } from 'drizzle-orm';
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

/** Транзакция, которая держит блокировки, пока проверка её не отпустит. */
export interface HeldTransaction {
  /** Процесс PostgreSQL, в котором она идёт: по нему опознаётся, кто кого ждёт. */
  readonly pid: number;
  /** Фиксирует транзакцию и закрывает её соединение. Повторный вызов ничего не делает. */
  release(): Promise<void>;
}

/**
 * Открывает транзакцию, выполняет в ней запрос и не завершает её до `release()`.
 *
 * Нужна проверкам одновременности ([ADR-0048](../../../../docs/adr/0048-poryadok-blokirovok-portov.md)):
 * держатель запирает строку, конкурирующее обращение встаёт на ней в ожидание посреди
 * своей транзакции, и порядок событий задаёт тест, а не планировщик. Паузы «на всякий
 * случай» здесь не годятся: они проверяют скорость машины, а не порядок.
 *
 * Своё соединение: общий пул приложения держатель занимать не должен.
 */
export async function holdTransaction(
  query: SQL,
  url = TEST_DATABASE_URL,
): Promise<HeldTransaction> {
  const handle = createDatabase({ url, poolMax: 1 });

  let letGo = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let started = (_pid: number): void => undefined;
  const ready = new Promise<number>((resolve) => {
    started = resolve;
  });

  const finished = handle.db.transaction(async (tx) => {
    const [own] = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows;
    if (own === undefined) throw new Error('pg_backend_pid() не вернул строку');
    await tx.execute(query);
    started(own.pid);
    await released;
  });

  let pid: number;
  try {
    // Запрос держателя может и упасть: тогда ждать готовности бессмысленно.
    pid = await Promise.race([
      ready,
      finished.then(() => {
        throw new Error('Транзакция держателя завершилась раньше, чем её отпустили');
      }),
    ]);
  } catch (cause) {
    letGo();
    await finished.catch(() => undefined);
    await handle.close();
    throw cause;
  }

  let closing: Promise<void> | undefined;
  return {
    pid,
    release() {
      closing ??= (async () => {
        letGo();
        try {
          await finished;
        } finally {
          await handle.close();
        }
      })();
      return closing;
    },
  };
}

/** Шаг опроса: ожидание блокировки наступает за единицы миллисекунд. */
const BLOCKED_POLL_MS = 20;

/**
 * Дожидается, что какой-то процесс базы встал в ожидание блокировки одного из `blockedBy`.
 *
 * Возвращает `pid` ждущего — по нему можно ждать следующее звено цепочки. Если раньше
 * завершилось `until` — обращение, которое должно было ждать, прошло сразу, — возвращает
 * `'settled'`: это не ошибка обвязки, а наблюдение, которое проверка вправе утверждать.
 *
 * Не дождался за `timeoutMs` — исключение: проверка, в которой никто никого не ждал,
 * проверяет не то, что написано в её названии.
 */
export async function waitUntilBlocked(
  options: { blockedBy: readonly number[]; until?: Promise<unknown>; timeoutMs?: number },
  url = TEST_DATABASE_URL,
): Promise<number | 'settled'> {
  // Флаг в объекте, а не в переменной: поток управления не видит присваивания
  // из обработчика и считал бы переменную навсегда `false`.
  const until = { settled: false };
  options.until?.then(
    () => {
      until.settled = true;
    },
    () => {
      until.settled = true;
    },
  );

  // Массив — одной строкой-литералом: шаблон drizzle разворачивает массив в список параметров.
  const blockers = `{${options.blockedBy.map((pid) => String(pid)).join(',')}}`;
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  const handle = createDatabase({ url, poolMax: 1 });
  try {
    for (;;) {
      const result = await handle.db.execute<{ pid: number }>(sql`
        select pid
          from pg_stat_activity
         where datname = current_database()
           and pg_blocking_pids(pid) && ${blockers}::int[]
           -- Звено цепочки, уже известное проверке, — не новый ждущий.
           and pid <> all(${blockers}::int[])
         limit 1
      `);
      const [waiting] = result.rows;
      if (waiting !== undefined) return waiting.pid;
      if (until.settled) return 'settled';
      if (Date.now() > deadline) {
        throw new Error(
          `За ${String(options.timeoutMs ?? 5000)} мс никто не встал в ожидание процессов ` +
            `${blockers}: проверка одновременности проверяет не то`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, BLOCKED_POLL_MS));
    }
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
 * Годные заявки для регистрации (ADR-0052): учётная запись участника заводится
 * вместе с заявкой на кабинет, и форма без анкеты отвергается.
 */
export const CLIENT_APPLICATION = {
  cabinet: 'client',
  answers: { companyName: 'Такси Проверка', city: 'Екатеринбург', phone: '+7 900 000-00-00' },
} as const;

export const PARTNER_APPLICATION = {
  cabinet: 'partner',
  answers: { region: 'Свердловская область', phone: '+7 900 000-00-00', operators: ['МТС'] },
} as const;

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
  await registerSipUser(app, nodeKey, gateway.sipUsername);
}

/**
 * То же для линии шлюза со входом по линиям
 * ([ADR-0054](../../../../docs/adr/0054-vhod-po-liniyam-goip.md)): регистрируется
 * вход порта, а не шлюза.
 */
export async function registerPort(
  app: NestFastifyApplication,
  nodeKey: string,
  portId: string,
): Promise<void> {
  const { TelephonyRepository } = await import('../modules/telephony/telephony.repository.js');
  const port = await app
    .get(TelephonyRepository)
    .findPort(portId as Parameters<TelephonyRepository['findPort']>[0]);
  if (port === undefined || port.sipUsername === null)
    throw new Error(`У порта ${portId} нет входа линии`);
  await registerSipUser(app, nodeKey, port.sipUsername);
}

/** Запрос каталога от имени узла; отказ каталога — исключение. */
async function registerSipUser(
  app: NestFastifyApplication,
  nodeKey: string,
  username: string,
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/node/directory',
    headers: {
      authorization: `Bearer ${nodeKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `section=directory&user=${username}&action=sip_auth`,
  });

  // Каталог отвечает всегда `200` и всегда XML: «записи нет» — тоже документ.
  // Отличить регистрацию от отказа можно только по содержимому.
  if (!response.body.includes('a1-hash')) {
    throw new Error(`Учётная запись ${username} не принята каталогом`);
  }
}
