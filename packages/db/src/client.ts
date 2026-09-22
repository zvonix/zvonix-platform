/**
 * Подключение к PostgreSQL.
 *
 * Пул создаётся один раз на процесс. Открывать соединение на запрос нельзя: установка
 * соединения с PostgreSQL стоит дороже самого запроса, а число соединений на сервере
 * ограничено и делится между API, воркером и потребителем событий.
 */

import {
  conflict,
  dependencyUnavailable,
  DomainError,
  internal,
  validationFailed,
} from '@zvonix/shared';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { CASING } from './casing.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

/**
 * Исполнитель запроса: пул или открытая транзакция.
 *
 * Объявлен один раз здесь, а не в каждом репозитории: тип выводится из `Database`,
 * и шесть его копий разъехались бы на первой же смене версии drizzle. Репозитории
 * его переэкспортируют, чтобы вызывающий брал тип оттуда же, откуда метод.
 */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/** Приёмник журнала запросов. Значения параметров не передаются намеренно. */
export type QueryLogger = (query: string, parameterCount: number) => void;

export interface DatabaseOptions {
  readonly url: string;
  /** Верхняя граница соединений этого процесса. Сумма по всем процессам — не больше `max_connections`. */
  readonly poolMax: number;
  /**
   * Журнал запросов для разработки.
   *
   * Принимает только текст запроса и число параметров. Значений параметров здесь нет
   * и быть не должно: в них хеши паролей, адреса почты и номера абонентов, а этот
   * вывод идёт мимо маскирования логгера (ADR-0004). Штатный журнал Drizzle печатает
   * их целиком, поэтому он не используется.
   */
  readonly logQuery?: QueryLogger;
  /**
   * Предел времени одного запроса, мс. `0` снимает ограничение.
   *
   * Снимать его нужно ровно в одном месте — при выполнении миграций: создание индекса
   * на большой таблице идёт минутами, и общий предел убил бы выкладку на середине.
   */
  readonly statementTimeoutMs?: number;
  /**
   * Ошибка простаивающего соединения пула.
   *
   * Пул восстанавливается сам, но без обработчика это событие остаётся необработанным
   * и роняет процесс. Логгер сюда не передаётся, чтобы пакет данных не зависел
   * от пакета логов; приложение подставляет свой.
   */
  readonly onPoolError?: (error: Error) => void;
}

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: Pool;
  /** Проверка живости для `/health`. Возвращает `false`, а не бросает: недоступность БД — штатное состояние. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Секунды. Значения намеренно небольшие: зависший запрос удерживает соединение пула,
 * и десяток таких оставляет процесс без соединений вообще. Лучше отдать ошибку
 * и освободить соединение, чем ждать неограниченно.
 */
const STATEMENT_TIMEOUT_MS = 15_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const statementTimeout = options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;

  const pool = new Pool({
    connectionString: options.url,
    max: options.poolMax,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    statement_timeout: statementTimeout,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    // Все отметки времени — `timestamptz`, и работать с ними нужно в UTC независимо
    // от настроек машины, где запущен процесс.
    options: '-c timezone=UTC',
  });

  const onPoolError = options.onPoolError;
  pool.on('error', (error: Error) => {
    if (onPoolError !== undefined) onPoolError(error);
  });

  const sink = options.logQuery;
  const db = drizzle(pool, {
    schema,
    casing: CASING,
    ...(sink === undefined
      ? {}
      : {
          logger: {
            logQuery: (query: string, parameters: unknown[]): void => {
              sink(query, parameters.length);
            },
          },
        }),
  });

  return {
    db,
    pool,
    async ping(): Promise<boolean> {
      try {
        await db.execute(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * Приводит ошибку драйвера к доменной.
 *
 * Наружу нельзя отдавать текст PostgreSQL: в нём имена таблиц, колонок и — в сообщении
 * о нарушении уникальности — само конфликтующее значение, то есть чужой адрес почты
 * или номер телефона.
 */
export function toDatabaseError(cause: unknown): DomainError {
  // Отказ, брошенный внутри транзакции, приходит сюда же, и он уже доменный. Разбирать
  // его как ошибку базы нельзя: его `code` (`'conflict'`) читался бы как SQLSTATE,
  // и `409` превращался бы в `500` (ADR-0048, §6).
  if (cause instanceof DomainError) return cause;

  const code = findSqlState(cause);

  switch (code) {
    // 23505 unique_violation
    case '23505':
      return conflict('Такая запись уже существует', { cause });
    // 23503 foreign_key_violation
    case '23503':
      return conflict('Связанная запись не найдена или ещё используется', { cause });
    // 23514 check_violation, 23502 not_null_violation
    case '23514':
    case '23502':
      return validationFailed('Данные не прошли проверку', { cause });
    // 40001 serialization_failure, 40P01 deadlock_detected — повтор транзакции уместен
    case '40001':
    case '40P01':
      return conflict('Конкурентное изменение, повторите операцию', { cause });
    // 57014 query_canceled — истёк statement_timeout, в том числе в ожидании блокировки;
    // 25P03 idle_in_transaction_session_timeout — база сама закрыла простаивающую транзакцию.
    // База жива, но не успела: «недоступна» было бы неправдой и увело бы разбор не туда.
    case '57014':
    case '25P03':
      return dependencyUnavailable('База данных не ответила вовремя — повторите позже', { cause });
    // 08006 connection_failure, 08003 connection_does_not_exist, 53300 too_many_connections
    case '08006':
    case '08003':
    case '53300':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
      return dependencyUnavailable('База данных недоступна', { cause });
    default:
      return internal('Ошибка обращения к базе данных', { cause });
  }
}

/** Ограничение глубины: цепочка причин может оказаться закольцованной. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Достаёт код ошибки из цепочки причин.
 *
 * Drizzle оборачивает ошибку драйвера в свою (`DrizzleQueryError`), и код `SQLSTATE`
 * лежит уровнем ниже. Смотреть только на верхнюю ошибку — значит превращать любое
 * нарушение уникальности во «внутреннюю ошибку»: клиент получит 500 вместо 409,
 * а в логе не останется причины.
 */
function findSqlState(value: unknown): string | null {
  let current = value;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;

    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
    if (!('cause' in current)) return null;
    current = current.cause;
  }

  return null;
}
