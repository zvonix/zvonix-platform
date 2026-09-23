/**
 * Настройки площадки на реальной базе (ADR-0031).
 *
 * Проверяется то, чего не видно без базы: секрет ложится шифротекстом и наружу
 * не возвращается, изменение попадает в журнал без значения секрета, а почта
 * и капча читают настройку, а не переменную окружения.
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
let adminToken = '';
let clientToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const auth = () => ({ authorization: `Bearer ${adminToken}` });

interface SettingRow {
  key: string;
  value: string | number | boolean | null;
  secret: boolean;
  is_set: boolean;
}

async function list(): Promise<SettingRow[]> {
  const response = await api().inject({ method: 'GET', url: '/settings', headers: auth() });
  expect(response.statusCode).toBe(200);
  return response.json<{ settings: SettingRow[] }>().settings;
}

async function change(settings: Record<string, unknown>) {
  return api().inject({ method: 'PUT', url: '/settings', headers: auth(), payload: { settings } });
}

async function storedValue(key: string): Promise<string | undefined> {
  return withDatabase(async (execute) => {
    const result = await execute(sql`select value from platform_settings where key = ${key}`);
    return (result.rows[0] as { value: string } | undefined)?.value;
  });
}

async function login(email: string): Promise<string> {
  const response = await api().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return response.json<{ token: string }>().token;
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();

  const { IdentityService } = await import('../identity/identity.service.js');
  const identity = api().get(IdentityService);

  const adminEmail = uniqueEmail();
  await identity.createByAdmin({
    email: adminEmail,
    password: TEST_PASSWORD,
    fullName: 'Администратор',
    role: 'admin',
    status: 'active',
  });
  adminToken = await login(adminEmail);

  const clientEmail = uniqueEmail();
  await identity.createByAdmin({
    email: clientEmail,
    password: TEST_PASSWORD,
    fullName: 'Клиент',
    role: 'client',
    status: 'active',
  });
  clientToken = await login(clientEmail);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('доступ', () => {
  it('без входа закрыт', async () => {
    expect((await api().inject({ method: 'GET', url: '/settings' })).statusCode).toBe(401);
  });

  it('клиенту закрыт: здесь адрес почтового сервера и имя для входа в него', async () => {
    const response = await api().inject({
      method: 'GET',
      url: '/settings',
      headers: { authorization: `Bearer ${clientToken}` },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('чтение', () => {
  it('свежая установка показывает весь список на умолчаниях', async () => {
    const settings = await list();
    expect(settings.length).toBeGreaterThan(5);
    expect(settings.every((row) => !row.is_set)).toBe(true);

    const host = settings.find((row) => row.key === 'mail.host');
    expect(host).toMatchObject({ value: '', secret: false });
  });

  it('секретные значения наружу не отдаются никогда', async () => {
    const settings = await list();
    for (const row of settings.filter((item) => item.secret)) {
      expect(row.value, row.key).toBeNull();
    }
    expect(settings.filter((row) => row.secret).map((row) => row.key)).toEqual([
      'mail.password',
      'captcha.server_key',
    ]);
  });
});

describe('запись', () => {
  it('меняет значения нужных видов', async () => {
    const response = await change({
      'mail.host': 'smtp.example.test',
      'mail.port': 2525,
      'mail.secure': true,
    });
    expect(response.statusCode).toBe(200);

    const settings = await list();
    expect(settings.find((row) => row.key === 'mail.host')).toMatchObject({
      value: 'smtp.example.test',
      is_set: true,
    });
    expect(settings.find((row) => row.key === 'mail.port')?.value).toBe(2525);
    expect(settings.find((row) => row.key === 'mail.secure')?.value).toBe(true);
  });

  it('неизвестный ключ — 404, а не тихая запись', async () => {
    // Список закрыт: настройка, о которой знает только база, не проверяется ничем
    // и живёт до первой опечатки.
    const response = await change({ 'mail.hosts': 'smtp.example.test' });
    expect(response.statusCode).toBe(404);
  });

  it('значение не того вида — 400', async () => {
    expect((await change({ 'mail.port': 'много' })).statusCode).toBe(400);
    expect((await change({ 'mail.secure': 'да' })).statusCode).toBe(400);
    expect((await change({ 'mail.host': 42 })).statusCode).toBe(400);
  });

  it('пустой набор изменений — 400', async () => {
    expect((await change({})).statusCode).toBe(400);
  });
});

describe('секреты', () => {
  it('в базе лежит шифротекст, а не пароль', async () => {
    // Смысл ровно один: дамп базы не должен отдавать пароль почты и серверный ключ капчи.
    expect((await change({ 'mail.password': 'очень секретный пароль' })).statusCode).toBe(200);

    const stored = await storedValue('mail.password');
    expect(stored).toBeDefined();
    expect(stored).not.toContain('очень секретный пароль');
    expect(stored?.split(':')).toHaveLength(3);
  });

  it('служба читает секрет обратно', async () => {
    await change({ 'mail.password': 'пароль-для-чтения' });

    const { SettingsService } = await import('./settings.service.js');
    const mail = await api().get(SettingsService).mail();
    expect(mail.password).toBe('пароль-для-чтения');
  });

  it('в журнал попадает факт изменения, но не значение', async () => {
    await change({ 'captcha.server_key': 'ysc2-совершенно-секретный' });

    const rows = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select after::text as after from audit_log
             where action = 'platform_settings.changed' order by occurred_at desc limit 1`,
      );
      return result.rows as { after: string }[];
    });

    expect(rows[0]?.after).toContain('captcha.server_key');
    expect(rows[0]?.after).not.toContain('ysc2-совершенно-секретный');
    expect(rows[0]?.after).toContain('скрыто');
  });
});

describe('почта берёт настройки отсюда', () => {
  it('пока узел не задан — почта не настроена', async () => {
    await change({ 'mail.host': '' });

    const { MailService } = await import('../mail/mail.service.js');
    expect(await api().get(MailService).isConfigured()).toBe(false);
  });

  it('задали узел — настроена, и без перезапуска', async () => {
    // Ради этого настройки и переехали в админку: правка действует сразу,
    // а не после выката.
    await change({ 'mail.host': 'smtp.example.test' });

    const { MailService } = await import('../mail/mail.service.js');
    expect(await api().get(MailService).isConfigured()).toBe(true);

    await change({ 'mail.host': '' });
  });

  it('пробное письмо при ненастроенной почте отвечает внятно', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/settings/mail/test',
      headers: auth(),
      payload: { recipient: 'admin@example.test' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('пробное письмо без адреса — отказ: адрес по умолчанию больше не хранится', async () => {
    await change({ 'mail.host': 'smtp.example.test' });
    const response = await api().inject({
      method: 'POST',
      url: '/settings/mail/test',
      headers: auth(),
      payload: {},
    });
    await change({ 'mail.host': '' });
    expect(response.statusCode).toBe(400);
  });

  it('прежней настройки адреса пробного письма в списке нет', async () => {
    const response = await api().inject({ method: 'GET', url: '/settings', headers: auth() });
    const keys = response.json<{ settings: { key: string }[] }>().settings.map((row) => row.key);
    expect(keys).not.toContain('mail.test_recipient');
  });
});

describe('капча', () => {
  it('состояние открыто без входа: без него форма не знает, рисовать ли виджет', async () => {
    const response = await api().inject({ method: 'GET', url: '/auth/captcha' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ register: false, login: false, password_reset: false });
  });

  it('включённая без ключей формой не показывается', async () => {
    await change({ 'captcha.on_login': true });

    const response = await api().inject({ method: 'GET', url: '/auth/captcha' });
    expect(response.json()).toMatchObject({ login: false });

    await change({ 'captcha.on_login': false });
  });

  it('включённая с ключами требует токен при регистрации', async () => {
    await change({
      'captcha.site_key': 'ysc1_site',
      'captcha.server_key': 'ysc2_server',
      'captcha.on_register': true,
    });

    const response = await api().inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: uniqueEmail(),
        password: TEST_PASSWORD,
        fullName: 'Иван Петров',
        ...CLIENT_APPLICATION,
      },
    });
    expect(response.statusCode).toBe(400);

    await change({
      'captcha.on_register': false,
      'captcha.site_key': '',
      'captcha.server_key': '',
    });
  });

  it('выключенная регистрации не мешает', async () => {
    const response = await api().inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: uniqueEmail(),
        password: TEST_PASSWORD,
        fullName: 'Иван Петров',
        ...CLIENT_APPLICATION,
      },
    });
    expect(response.statusCode).toBe(202);
  });
});
