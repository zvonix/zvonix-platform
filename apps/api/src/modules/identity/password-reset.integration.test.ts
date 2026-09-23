/**
 * Восстановление пароля и подтверждение адреса (ADR-0029).
 *
 * Письмо не отправляется по-настоящему — SMTP в проверках не настроен, и это штатное
 * состояние: письма копятся в таблице. Токен читается оттуда же, откуда его прочитал бы
 * человек, — из тела письма.
 *
 * Проверяется главное: ответ не зависит от существования записи, ссылка работает один
 * раз, а восстановление закрывает **все** сессии.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  CLIENT_APPLICATION,
  prepareEnvironment,
  resetDatabase,
  startApi,
  TEST_PASSWORD,
  uniqueEmail,
  withDatabase,
} from '../../testing/harness.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

async function post(url: string, payload: Record<string, unknown>) {
  return api().inject({ method: 'POST', url, payload });
}

/** Регистрирует и возвращает адрес: ответ о записи ничего не сообщает. */
async function registered(): Promise<string> {
  const email = uniqueEmail();
  const response = await post('/auth/register', {
    email,
    password: TEST_PASSWORD,
    fullName: 'Иван Петров',
    ...CLIENT_APPLICATION,
  });
  expect(response.statusCode).toBe(202);
  return email;
}

async function activate(email: string): Promise<void> {
  await withDatabase(async (execute) => {
    await execute(sql`update users set status = 'active' where email = ${email}`);
  });
}

/** Письма, ушедшие на адрес, — в порядке появления. */
async function letters(email: string): Promise<{ kind: string; body: string }[]> {
  return withDatabase(async (execute) => {
    const result = await execute(
      sql`select kind, body from outbox_messages where recipient = ${email} order by created_at`,
    );
    return result.rows as { kind: string; body: string }[];
  });
}

/** Токен из письма — ровно оттуда, откуда его возьмёт человек. */
function tokenFrom(body: string): string {
  const match = /token=([^\s]+)/.exec(body);
  if (match?.[1] === undefined) throw new Error('В письме нет ссылки с токеном');
  return decodeURIComponent(match[1]);
}

async function login(email: string, password: string): Promise<string | undefined> {
  const response = await post('/auth/login', { email, password });
  return response.statusCode === 200 ? response.json<{ token: string }>().token : undefined;
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('подтверждение адреса', () => {
  it('регистрация кладёт письмо в очередь', async () => {
    const email = await registered();
    expect((await letters(email)).map((row) => row.kind)).toEqual(['email_verification']);
  }, 120_000);

  it('ссылка подтверждает адрес, но доступа не открывает', async () => {
    // Партнёра допускает администратор: связать это с почтой значило бы пустить
    // в систему любого, у кого есть ящик.
    const email = await registered();
    const token = tokenFrom((await letters(email))[0]?.body ?? '');

    expect((await post('/auth/email/confirm', { token })).statusCode).toBe(204);

    const stored = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select status, email_confirmed_at from users where email = ${email}`,
      );
      return result.rows[0] as { status: string; email_confirmed_at: string | null };
    });
    expect(stored.email_confirmed_at).not.toBeNull();
    expect(stored.status).toBe('pending');
  }, 120_000);

  it('ссылка срабатывает один раз', async () => {
    const email = await registered();
    const token = tokenFrom((await letters(email))[0]?.body ?? '');

    expect((await post('/auth/email/confirm', { token })).statusCode).toBe(204);
    expect((await post('/auth/email/confirm', { token })).statusCode).toBe(401);
  }, 120_000);

  it('выдуманный токен отвечает как просроченный', async () => {
    // Разница сообщала бы, что такой токен когда-то существовал.
    const response = await post('/auth/email/confirm', { token: 'x'.repeat(43) });
    expect(response.statusCode).toBe(401);
  }, 120_000);
});

describe('восстановление пароля', () => {
  it('ответ одинаков для существующего и выдуманного адреса', async () => {
    // Разница в ответе — это способ перебрать адреса.
    const email = await registered();

    const known = await post('/auth/password-reset', { email });
    const unknown = await post('/auth/password-reset', { email: uniqueEmail() });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
  }, 120_000);

  it('меняет пароль по ссылке и закрывает все сессии', async () => {
    const email = await registered();
    await activate(email);
    const session = await login(email, TEST_PASSWORD);
    expect(session).toBeDefined();

    await post('/auth/password-reset', { email });
    const letter = (await letters(email)).find((row) => row.kind === 'password_reset');
    expect(letter).toBeDefined();

    const confirmed = await post('/auth/password-reset/confirm', {
      token: tokenFrom(letter?.body ?? ''),
      newPassword: 'совершенно другой пароль',
    });
    expect(confirmed.statusCode).toBe(204);

    // Пароль восстанавливают, когда доступ потерян: прежняя сессия закрывается тоже.
    const meResponse = await api().inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${session ?? ''}` },
    });
    expect(meResponse.statusCode).toBe(401);

    expect(await login(email, 'совершенно другой пароль')).toBeDefined();
    expect(await login(email, TEST_PASSWORD)).toBeUndefined();
  }, 120_000);

  it('вторая заявка гасит первую ссылку', async () => {
    // Письмо недельной давности не должно работать наравне со свежим.
    const email = await registered();
    await activate(email);

    await post('/auth/password-reset', { email });
    const first = (await letters(email)).filter((row) => row.kind === 'password_reset');
    await post('/auth/password-reset', { email });
    const both = (await letters(email)).filter((row) => row.kind === 'password_reset');
    expect(both).toHaveLength(2);

    const stale = await post('/auth/password-reset/confirm', {
      token: tokenFrom(first[0]?.body ?? ''),
      newPassword: 'ещё один длинный пароль',
    });
    expect(stale.statusCode).toBe(401);

    const fresh = await post('/auth/password-reset/confirm', {
      token: tokenFrom(both[1]?.body ?? ''),
      newPassword: 'ещё один длинный пароль',
    });
    expect(fresh.statusCode).toBe(204);
  }, 120_000);

  it('ссылка срабатывает один раз', async () => {
    const email = await registered();
    await activate(email);
    await post('/auth/password-reset', { email });
    const token = tokenFrom(
      (await letters(email)).find((row) => row.kind === 'password_reset')?.body ?? '',
    );

    expect(
      (await post('/auth/password-reset/confirm', { token, newPassword: 'длинный пароль номер' }))
        .statusCode,
    ).toBe(204);
    expect(
      (await post('/auth/password-reset/confirm', { token, newPassword: 'другой длинный пароль' }))
        .statusCode,
    ).toBe(401);
  }, 120_000);

  it('короткий новый пароль отвергается', async () => {
    const email = await registered();
    await post('/auth/password-reset', { email });
    const token = tokenFrom(
      (await letters(email)).find((row) => row.kind === 'password_reset')?.body ?? '',
    );

    expect(
      (await post('/auth/password-reset/confirm', { token, newPassword: 'коротко' })).statusCode,
    ).toBe(400);
  }, 120_000);

  it('отключённой записи письмо не уходит', async () => {
    // Молчим: письмо «такого адреса у нас нет» сообщало бы ровно то, что мы скрываем.
    const email = await registered();
    await withDatabase(async (execute) => {
      await execute(sql`update users set status = 'disabled' where email = ${email}`);
    });

    expect((await post('/auth/password-reset', { email })).statusCode).toBe(202);
    expect((await letters(email)).filter((row) => row.kind === 'password_reset')).toHaveLength(0);
  }, 120_000);
});

describe('предел писем на один адрес', () => {
  it('одиннадцатое письмо за час на адрес не уходит, а ответ не меняется', async () => {
    // Ограничение частоты по адресу источника от заваливания одного ящика не спасает:
    // адресов источника у ботнета много, а цель одна ([ADR-0030](../../../../../docs/adr/0030-predel-pisem-na-adres.md)).
    const email = await registered();

    for (let attempt = 1; attempt <= 15; attempt += 1) {
      const response = await post('/auth/password-reset', { email });
      expect(response.statusCode, `заявка ${String(attempt)}`).toBe(202);
    }

    // Регистрация уже отправила письмо с подтверждением — оно тоже в счёте.
    expect(await letters(email)).toHaveLength(10);
  }, 120_000);

  it('исчерпанный предел не гасит действующую ссылку', async () => {
    // Иначе заваливание ящика заодно лишало бы человека возможности восстановить пароль:
    // каждая заявка гасит предыдущую ссылку, а письма с новой уже не приходит.
    const email = await registered();

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await post('/auth/password-reset', { email });
    }
    const queued = (await letters(email)).filter((row) => row.kind === 'password_reset');
    expect(queued).toHaveLength(9);
    const last = tokenFrom(queued[8]?.body ?? '');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post('/auth/password-reset', { email });
    }
    expect(await letters(email)).toHaveLength(10);

    const confirmed = await post('/auth/password-reset/confirm', {
      token: last,
      newPassword: 'ещё один длинный пароль',
    });
    expect(confirmed.statusCode).toBe(204);
  }, 120_000);

  it('считает адреса по отдельности', async () => {
    const flooded = await registered();
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await post('/auth/password-reset', { email: flooded });
    }

    const innocent = await registered();
    await post('/auth/password-reset', { email: innocent });
    expect((await letters(innocent)).map((row) => row.kind)).toEqual([
      'email_verification',
      'password_reset',
    ]);
  }, 120_000);
});

describe('очередь писем', () => {
  it('при ненастроенной почте письма копятся, а не теряются', async () => {
    // Штатное состояние разработки и признак того, что почту забыли настроить:
    // таблица растёт, воркер предупреждает.
    const email = await registered();
    const { MailService } = await import('../mail/mail.service.js');
    const mail = api().get(MailService);

    expect(await mail.isConfigured()).toBe(false);
    expect(await mail.deliverDue(new Date())).toBe(0);
    expect((await letters(email))[0]?.kind).toBe('email_verification');
  }, 120_000);
});
