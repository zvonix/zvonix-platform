/**
 * Интеграционные проверки на реальной PostgreSQL (ADR-0006).
 *
 * Проверяют то, что unit-тест проверить не может: что миграция вообще применяется,
 * что ограничения работают, что типы переживают запись и чтение. Схема, «сходящаяся
 * по типам», может при этом не создаваться в базе — узнать об этом до выкладки
 * можно только выполнив её.
 *
 * Адрес тестовой базы — в `TEST_DATABASE_URL`. Запуск: `pnpm test:integration`.
 */

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type Id } from '@zvonix/shared';
import { createDatabase, toDatabaseError, type DatabaseHandle } from './client.js';
import { applyMigrations } from './migrate.js';
import { containsIgnoringCase, orderByText } from './search.js';
import { sessions, users } from './schema/index.js';

const url =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://zvonix:zvonix@127.0.0.1:5432/zvonix_test';

/**
 * Тест очищает схему целиком, поэтому имя базы обязано заканчиваться на `_test`.
 * Опечатка в переменной окружения не должна стоить рабочей базы.
 */
function assertTestDatabase(connectionUrl: string): void {
  const name = new URL(connectionUrl).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Отказ: имя базы «${name}» не оканчивается на _test`);
  }
}

// Может остаться незаданным: если beforeAll упал на подключении, afterAll всё равно вызовут.
let handle: DatabaseHandle | undefined;

function makeUser(overrides: Partial<typeof users.$inferInsert> = {}): typeof users.$inferInsert {
  const id = newId<'user'>();
  return {
    id,
    email: `${id}@example.test`,
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash',
    fullName: 'Иван Петров',
    role: 'client',
    ...overrides,
  };
}

/** Подключение после beforeAll. Отдельная функция, чтобы не писать `handle!` в каждом тесте. */
function connected(): DatabaseHandle {
  if (handle === undefined) throw new Error('Подключение не создано');
  return handle;
}

beforeAll(async () => {
  assertTestDatabase(url);
  handle = createDatabase({ url, poolMax: 2 });

  // Каждый прогон начинается с пустой базы: тест не должен зависеть от того,
  // что осталось от предыдущего.
  await connected().db.execute(sql`drop schema if exists public cascade`);
  await connected().db.execute(sql`create schema public`);
  await connected().db.execute(sql`drop table if exists drizzle.__drizzle_migrations`);

  await applyMigrations(connected().db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

describe('подключение', () => {
  it('отвечает на проверку живости', async () => {
    await expect(connected().ping()).resolves.toBe(true);
  });

  it('работает в UTC независимо от настроек машины', async () => {
    // Через current_setting, а не `show timezone`: у последнего имя колонки — `TimeZone`,
    // и обращение к нему зависит от регистра.
    const result = await connected().db.execute<{ tz: string }>(
      sql`select current_setting('TIMEZONE') as tz`,
    );
    expect(result.rows[0]?.tz).toBe('UTC');
  });
});

describe('миграции', () => {
  it('применяются повторно без изменений', async () => {
    // Узел выкладки может запустить миграции дважды: это не должно ничего ломать.
    await expect(applyMigrations(connected().db)).resolves.toBeUndefined();
  });

  it('создали все таблицы схемы', async () => {
    const result = await connected().db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = result.rows.map((row) => row.table_name);
    expect(names).toEqual(expect.arrayContaining(['users', 'sessions', 'audit_log']));
  });
});

describe('users', () => {
  it('записывает и читает учётную запись', async () => {
    const draft = makeUser();
    const [saved] = await connected().db.insert(users).values(draft).returning();

    expect(saved).toBeDefined();
    expect(saved?.id).toBe(draft.id);
    expect(saved?.status).toBe('pending');
    expect(saved?.failedLoginCount).toBe(0);
    expect(saved?.createdAt).toBeInstanceOf(Date);
    expect(saved?.totpSecret).toBeNull();
  });

  it('отвергает роль вне списка', async () => {
    const attempt = connected()
      .db.insert(users)
      .values(makeUser({ role: 'кот' as 'client' }));
    await expect(attempt).rejects.toThrow();

    await attempt.catch((cause: unknown) => {
      expect(toDatabaseError(cause).code).toBe('validation_failed');
    });
  });

  it('отвергает адрес не в нижнем регистре', async () => {
    // Иначе «Ivan@…» и «ivan@…» станут двумя учётными записями.
    const attempt = connected()
      .db.insert(users)
      .values(makeUser({ email: 'Ivan@Example.Test' }));
    await expect(attempt).rejects.toThrow();
  });

  it('отвергает подтверждённый второй фактор без секрета', async () => {
    const attempt = connected()
      .db.insert(users)
      .values(makeUser({ totpConfirmedAt: new Date(), totpSecret: null }));
    await expect(attempt).rejects.toThrow();
  });

  it('не допускает двух учётных записей с одним адресом', async () => {
    const email = `${newId<'user'>()}@example.test`;
    await connected().db.insert(users).values(makeUser({ email }));

    const attempt = connected().db.insert(users).values(makeUser({ email }));
    await expect(attempt).rejects.toThrow();

    await attempt.catch((cause: unknown) => {
      const error = toDatabaseError(cause);
      expect(error.code).toBe('conflict');
      // Текст драйвера содержит и адрес, и имя ограничения — наружу он не уходит.
      expect(error.message).not.toContain(email);
    });
  });

  it('обновляет updated_at при изменении', async () => {
    const draft = makeUser();
    const [created] = await connected().db.insert(users).values(draft).returning();
    expect(created).toBeDefined();

    const [updated] = await connected()
      .db.update(users)
      .set({ status: 'active' })
      .where(sql`${users.id} = ${draft.id}`)
      .returning();

    expect(updated?.status).toBe('active');
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      created?.updatedAt.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });
});

describe('sessions', () => {
  it('удаляются вместе с учётной записью', async () => {
    // Иначе после удаления остаётся действующий доступ без владельца.
    const draft = makeUser();
    await connected().db.insert(users).values(draft);

    const sessionId = newId<'session'>();
    await connected()
      .db.insert(sessions)
      .values({
        id: sessionId,
        userId: draft.id as Id<'user'>,
        tokenHash: `hash-${sessionId}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        ip: '127.0.0.1',
      });

    await connected()
      .db.delete(users)
      .where(sql`${users.id} = ${draft.id}`);

    const left = await connected()
      .db.select()
      .from(sessions)
      .where(sql`${sessions.id} = ${sessionId}`);
    expect(left).toHaveLength(0);
  });

  it('не допускает двух сессий с одним хешем токена', async () => {
    const draft = makeUser();
    await connected().db.insert(users).values(draft);

    const tokenHash = `hash-${newId<'session'>()}`;
    const row = {
      userId: draft.id as Id<'user'>,
      tokenHash,
      expiresAt: new Date(Date.now() + 3_600_000),
    };

    await connected()
      .db.insert(sessions)
      .values({ id: newId<'session'>(), ...row });
    await expect(
      connected()
        .db.insert(sessions)
        .values({ id: newId<'session'>(), ...row }),
    ).rejects.toThrow();
  });
});

describe('журнал запросов', () => {
  it('получает текст запроса, но не значения параметров', async () => {
    // Штатный журнал Drizzle печатает параметры целиком — в них хеши паролей,
    // адреса и номера абонентов, — и делает это мимо маскирования логгера (ADR-0004).
    const seen: { query: string; parameters: number }[] = [];
    const logged = createDatabase({
      url,
      poolMax: 1,
      logQuery: (query, parameters) => seen.push({ query, parameters }),
    });

    try {
      const secret = 'значение-которого-не-должно-быть-в-логе';
      await logged.db.execute(sql`select ${secret}::text as value`);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.query).toContain('select');
      expect(seen[0]?.parameters).toBe(1);
      expect(JSON.stringify(seen)).not.toContain(secret);
    } finally {
      await logged.close();
    }
  });

  it('молчит, когда приёмник не задан', async () => {
    const silent = createDatabase({ url, poolMax: 1 });
    try {
      await expect(silent.db.execute(sql`select 1`)).resolves.toBeDefined();
    } finally {
      await silent.close();
    }
  });
});

describe('ошибки', () => {
  it('превышение statement_timeout превращается в недоступность зависимости', async () => {
    // Зависший запрос удерживает соединение пула; лучше отдать ошибку, чем ждать.
    const attempt = connected().db.execute(sql`set statement_timeout = 50; select pg_sleep(1)`);
    await expect(attempt).rejects.toThrow();

    await attempt.catch((cause: unknown) => {
      expect(toDatabaseError(cause).code).toBe('dependency_unavailable');
    });
  });
});

/**
 * Поиск без учёта регистра по-русски.
 *
 * Проверка стоит здесь, а не в модуле, который ищет: она про базу, а не про домен.
 * PostgreSQL приводит регистр по локали, и в локали `C` кириллица не приводится
 * вовсе — поиск при этом не падает, а молча ничего не находит.
 */
describe('поиск без учёта регистра', () => {
  it('«такси» находит «Такси», и «ТАКСИ» тоже', async () => {
    const draft = makeUser({ fullName: 'Служба Такси Первое' });
    await connected().db.insert(users).values(draft);

    for (const needle of ['такси', 'ТАКСИ', 'ТаКсИ']) {
      const rows = await connected()
        .db.select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, draft.id), containsIgnoringCase(users.fullName, needle)));
      expect(rows, `по запросу «${needle}»`).toHaveLength(1);
    }
  });

  it('штатный ilike этого не умеет — ради этого помощник и заведён', async () => {
    // Не проверка нашего кода, а фиксация свойства базы. Если однажды локаль сменят
    // и `ilike` заработает сам, эта проверка упадёт — и это правильно: значит
    // помощник больше не нужен, и об этом надо узнать, а не догадываться.
    const found = await connected().db.execute(sql`select ('Такси' ilike '%такси%') as plain,
      (('Такси' collate "und-x-icu") ilike '%такси%') as with_locale`);
    const row = found.rows[0] as { plain: boolean; with_locale: boolean };
    expect(row.with_locale).toBe(true);
    expect(row.plain).toBe(false);
  });

  it('знаки шаблона в запросе ничего не значат', async () => {
    const draft = makeUser({ fullName: 'Обычное имя' });
    await connected().db.insert(users).values(draft);

    const rows = await connected()
      .db.select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, draft.id), containsIgnoringCase(users.fullName, '%')));
    expect(rows).toHaveLength(0);
  });
});

/**
 * Порядок русских названий.
 *
 * Та же болезнь, что и у поиска, и тоже свойство базы, а не домена: в локали `C`
 * сравнение идёт по кодам символов, и все заглавные оказываются раньше строчных.
 */
describe('порядок по названию', () => {
  it('регистр не решает, кто первый', async () => {
    const mark = `Я${String(Date.now()).slice(-7)}`;
    const drafts = [
      makeUser({ fullName: `${mark} Яндекс` }),
      makeUser({ fullName: `${mark} абв` }),
      makeUser({ fullName: `${mark} Бета` }),
    ];
    await connected().db.insert(users).values(drafts);

    const rows = await connected()
      .db.select({ fullName: users.fullName })
      .from(users)
      .where(containsIgnoringCase(users.fullName, mark))
      .orderBy(orderByText(users.fullName));

    expect(rows.map((row) => row.fullName)).toEqual([
      `${mark} абв`,
      `${mark} Бета`,
      `${mark} Яндекс`,
    ]);
  });

  it('штатный порядок этого не умеет — ради этого помощник и заведён', async () => {
    // Фиксация свойства базы: сменят локаль — проверка упадёт, и об этом надо узнать.
    const found = await connected().db.execute(
      sql`select ('Яндекс' < 'абв') as plain,
        (('Яндекс' collate "und-x-icu") < ('абв' collate "und-x-icu")) as with_locale`,
    );
    const row = found.rows[0] as { plain: boolean; with_locale: boolean };
    expect(row.plain).toBe(true);
    expect(row.with_locale).toBe(false);
  });
});
