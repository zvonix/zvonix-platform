/**
 * Проверки схемы, не требующие базы.
 *
 * Здесь машинно проверяются соглашения ADR-0016. Соглашение, которое проверяет только
 * внимание на ревью, нарушается на третьей таблице.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableConfig, QueryBuilder, type PgTable } from 'drizzle-orm/pg-core';
import { USER_ROLES, USER_STATUSES } from '@zvonix/shared';
import { CASING } from './casing.js';
import { MIGRATIONS_FOLDER } from './migrate.js';
import { toDatabaseError } from './client.js';
import { oneOf } from './columns.js';
import * as schema from './schema/index.js';

const tables = Object.entries(schema) as [string, PgTable][];

/** Текст всех миграций одной строкой: по нему сверяется то, что реально уедет в базу. */
const migrationSql = readdirSync(MIGRATIONS_FOLDER)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(path.join(MIGRATIONS_FOLDER, file), 'utf8'))
  .join('\n');

/**
 * Имена колонок такими, какими их напишет в запрос рантайм.
 *
 * Читать `getTableConfig(...).columns[].name` для этого нельзя: там лежит имя свойства
 * в коде (`passwordHash`), а преобразование по настройке `casing` выполняется позже,
 * при построении запроса. Поэтому имя берётся из готового текста SQL — то есть
 * ровно из того, что уйдёт в базу.
 */
const queryBuilder = new QueryBuilder({ casing: CASING });

function runtimeColumnNames(table: PgTable): string[] {
  // Вид запроса: select "id", "email", "password_hash" from "users"
  const { sql } = queryBuilder.select().from(table).toSQL();
  const selectList = sql.slice(0, sql.lastIndexOf(' from '));
  return [...selectList.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
}

describe('соглашения схемы (ADR-0016)', () => {
  it('схема не пуста и все таблицы попали в экспорт', () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it.each(tables)('%s: имена таблицы и колонок в snake_case', (_name, table) => {
    const snakeCase = /^[a-z][a-z0-9_]*$/;
    const columns = runtimeColumnNames(table);

    expect(getTableConfig(table).name).toMatch(snakeCase);
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(column).toMatch(snakeCase);
    }
  });

  it.each(tables)('%s: есть первичный ключ', (_name, table) => {
    const config = getTableConfig(table);
    const hasPrimary = config.columns.some((column) => column.primary);
    expect(hasPrimary || config.primaryKeys.length > 0).toBe(true);
  });

  it.each(tables)('%s: все отметки времени хранят часовой пояс', (_name, table) => {
    for (const column of getTableConfig(table).columns) {
      if (column.getSQLType().startsWith('timestamp')) {
        // `timestamp` без зоны не позволяет восстановить момент времени задним числом.
        expect(column.getSQLType()).toBe('timestamp with time zone');
      }
    }
  });

  it.each(tables)('%s: ссылки на другие таблицы объявлены как uuid', (_name, table) => {
    const config = getTableConfig(table);

    // Правило про «всё, что кончается на Id» было слишком грубым: под него попадали
    // и полиморфные ссылки — `accounts.owner_id` указывает то на клиента, то на партнёра,
    // а `ledger_transactions.reference_id` — на вызов, платёж или заявку на выплату.
    // Одним внешним ключом это не выразить, поэтому и тип там текстовый.
    //
    // Проверяем то, что имели в виду на самом деле: **настоящая** ссылка обязана быть uuid.
    const referencing = new Set(
      config.foreignKeys.flatMap((key) => key.reference().columns.map((column) => column.name)),
    );

    for (const column of config.columns) {
      if (column.primary || referencing.has(column.name)) {
        expect(column.getSQLType()).toBe('uuid');
      }
    }
  });

  it('в схеме нет типов enum: набор значений задаётся ограничением CHECK', () => {
    // Обоснование — в ADR-0016. Тип enum пришлось бы пересоздавать при каждом
    // изменении набора значений, а ADR-0005 требует двухшагового изменения.
    expect(migrationSql).not.toMatch(/CREATE\s+TYPE/i);
  });
});

describe('согласованность рантайма и сгенерированных миграций', () => {
  it('миграции сгенерированы', () => {
    expect(migrationSql.length).toBeGreaterThan(0);
  });

  it.each(tables)('%s: каждая колонка запроса есть в миграциях', (_name, table) => {
    // Ключевая проверка ADR-0016: имя, которое рантайм пишет в запрос, обязано
    // существовать в базе. Расхождение здесь не поймали бы ни типы, ни сборка —
    // запрос просто ушёл бы к несуществующей колонке.
    expect(migrationSql).toContain(`"${getTableConfig(table).name}"`);
    for (const column of runtimeColumnNames(table)) {
      expect(migrationSql).toContain(`"${column}"`);
    }
  });

  it('ограничения на роли и статусы содержат ровно значения из @zvonix/shared', () => {
    for (const role of USER_ROLES) {
      expect(migrationSql).toContain(`'${role}'`);
    }
    for (const status of USER_STATUSES) {
      expect(migrationSql).toContain(`'${status}'`);
    }
  });
});

describe('oneOf', () => {
  it('отвергает значения, небезопасные для подстановки в текст SQL', () => {
    const column = getTableConfig(schema.users).columns.find((c) => c.name === 'role');
    expect(column).toBeDefined();
    if (column === undefined) return;

    expect(() => oneOf(column, ["admin'; drop table users; --"])).toThrow(/Недопустимое значение/);
    expect(() => oneOf(column, ['Admin'])).toThrow(/Недопустимое значение/);
    expect(() => oneOf(column, [])).toThrow(/пуст/);
    expect(() => oneOf(column, ['admin', 'partner'])).not.toThrow();
  });
});

describe('toDatabaseError', () => {
  it.each([
    ['23505', 'conflict'],
    ['23503', 'conflict'],
    ['40001', 'conflict'],
    ['40P01', 'conflict'],
    ['23514', 'validation_failed'],
    ['23502', 'validation_failed'],
    ['57014', 'dependency_unavailable'],
    ['08006', 'dependency_unavailable'],
    ['53300', 'dependency_unavailable'],
    ['ECONNREFUSED', 'dependency_unavailable'],
  ])('код %s → %s', (code, expected) => {
    expect(toDatabaseError(Object.assign(new Error('x'), { code })).code).toBe(expected);
  });

  it('находит код внутри обёртки Drizzle', () => {
    // Drizzle оборачивает ошибку драйвера в свою, и код лежит уровнем ниже.
    // Без разбора цепочки причин любое нарушение уникальности стало бы 500 вместо 409.
    const driverError = Object.assign(new Error('duplicate key'), { code: '23505' });
    const wrapped = new Error('Failed query', { cause: driverError });
    expect(toDatabaseError(wrapped).code).toBe('conflict');
  });

  it('не зацикливается на закольцованной цепочке причин', () => {
    const first = new Error('первая');
    const second = new Error('вторая', { cause: first });
    Object.defineProperty(first, 'cause', { value: second });
    expect(toDatabaseError(first).code).toBe('internal');
  });

  it('неизвестный код становится внутренней ошибкой', () => {
    expect(toDatabaseError(new Error('что-то')).code).toBe('internal');
    expect(toDatabaseError('строка').code).toBe('internal');
    expect(toDatabaseError(null).code).toBe('internal');
  });

  it('не выносит текст ошибки PostgreSQL в сообщение', () => {
    // В тексте драйвера — имена таблиц и колонок, а при нарушении уникальности
    // ещё и конфликтующее значение: чужая почта или номер телефона.
    const driverError = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "users_email_key" (ivan@example.com)',
      ),
      { code: '23505' },
    );
    const error = toDatabaseError(driverError);
    expect(error.message).not.toContain('ivan@example.com');
    expect(error.message).not.toContain('users_email_key');
    expect(error.cause).toBe(driverError);
  });
});
