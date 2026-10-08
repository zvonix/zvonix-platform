/**
 * Бот MAX (ADR-0077, этап 1а): регистрация бота площадки, подключение клиента, события бота — подписчики и номер
 * только из своего контакта, «СТОП». Платформа подменена имитацией.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  withDatabase,
} from '../../../testing/harness.js';
import { bearer, fixtures } from '../messaging.fixtures.js';
import { BotsService } from './bots.service.js';
import { simulatedBotSent, simulatedBotSubscriptions } from './simulated-bot.provider.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const fx = fixtures(api, () => adminToken);

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  adminToken = (await fx.user('admin')).token;
});

beforeEach(async () => {
  await withDatabase(async (execute) => {
    await execute(sql`delete from bot_subscribers`);
    await execute(sql`delete from bot_connections`);
    await execute(sql`delete from messenger_bots`);
  });
  simulatedBotSent.length = 0;
  simulatedBotSubscriptions.clear();
  expect((await fx.put(adminToken, { 'bot.enabled': true })).statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
});

const register = (token: string, body: Record<string, unknown>) =>
  api().inject({ method: 'PUT', url: '/bots/platform', headers: bearer(token), payload: body });

const botIdOf = (): Promise<string> =>
  withDatabase(async (execute) => {
    const result = await execute(sql`select id from messenger_bots limit 1`);
    return (result.rows[0] as { id: string }).id;
  });

/** Событие бота на вебхук с правильным секретом (или с заданным). */
async function event(botId: string, body: unknown, secret?: string) {
  return api().inject({
    method: 'POST',
    url: `/webhooks/max-bot/${botId}`,
    headers: { 'x-max-bot-api-secret': secret ?? api().get(BotsService).webhookSecret(botId) },
    payload: body as Record<string, unknown>,
  });
}

interface BotView {
  enabled: boolean;
  bot: {
    name: string;
    username: string;
    status: string;
    clients: number;
    subscribers: number;
  } | null;
}

describe('бот площадки у администратора', () => {
  it('токен проверяется у MAX, вебхук настраивается с секретом бота, запись пишется в журнал', async () => {
    expect((await register(adminToken, { token: 'чужой-токен' })).statusCode).toBe(400);
    expect((await register(adminToken, { token: '  ' })).statusCode).toBe(400);

    const ok = await register(adminToken, { token: 'ok-taxibot' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<BotView>().bot).toMatchObject({
      username: 'taxibot_bot',
      status: 'active',
      clients: 0,
      subscribers: 0,
    });
    // Токен нигде не отдаётся.
    expect(ok.body).not.toContain('ok-taxibot');

    const id = await botIdOf();
    const subscription = simulatedBotSubscriptions.get('ok-taxibot');
    expect(subscription?.url).toContain(`/api/webhooks/max-bot/${id}`);
    expect(subscription?.secret).toBe(api().get(BotsService).webhookSecret(id));

    // Повторная запись заменяет токен у того же бота.
    expect((await register(adminToken, { token: 'ok-taxibot' })).statusCode).toBe(200);
    expect(await botIdOf()).toBe(id);

    const logged = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as n from audit_log where action = 'messenger_bot.registered'`,
      );
      return (result.rows[0] as { n: number }).n;
    });
    expect(logged).toBe(2);
  });

  it('читает администратор и поддержка, пишет только администратор; клиент не видит раздела', async () => {
    const support = await fx.user('support');
    const client = await fx.clientWithMoney('1');
    const get = (token: string) =>
      api().inject({ method: 'GET', url: '/bots/platform', headers: bearer(token) });

    expect((await get(adminToken)).statusCode).toBe(200);
    expect((await get(support.token)).statusCode).toBe(200);
    expect((await get(client.token)).statusCode).toBe(403);
    expect((await register(support.token, { token: 'ok-taxibot' })).statusCode).toBe(403);
    expect((await register(client.token, { token: 'ok-taxibot' })).statusCode).toBe(403);
  });

  it('отключение снимает подписку у MAX; проверка возвращает бота в работу', async () => {
    await register(adminToken, { token: 'ok-taxibot' });
    const disabled = await api().inject({
      method: 'POST',
      url: '/bots/platform/disable',
      headers: bearer(adminToken),
    });
    expect(disabled.json<BotView>().bot?.status).toBe('disabled');
    expect(simulatedBotSubscriptions.has('ok-taxibot')).toBe(false);

    const checked = await api().inject({
      method: 'POST',
      url: '/bots/platform/check',
      headers: bearer(adminToken),
    });
    expect(checked.json<BotView>().bot?.status).toBe('active');
    expect(simulatedBotSubscriptions.has('ok-taxibot')).toBe(true);
  });
});

describe('бот в кабинете клиента', () => {
  const view = (token: string) =>
    api().inject({ method: 'GET', url: '/client/messages/bot', headers: bearer(token) });

  it('пока бота нет или продукт выключен — недоступен; потом подключается, ссылка не меняется, выключается', async () => {
    const client = await fx.clientWithMoney('1');
    expect((await view(client.token)).json<{ available: boolean }>().available).toBe(false);
    expect(
      (
        await api().inject({
          method: 'POST',
          url: '/client/messages/bot',
          headers: bearer(client.token),
        })
      ).statusCode,
    ).toBe(409);

    await register(adminToken, { token: 'ok-taxibot' });
    const connected = await api().inject({
      method: 'POST',
      url: '/client/messages/bot',
      headers: bearer(client.token),
    });
    expect(connected.statusCode).toBe(201);
    const first = connected.json<{
      available: boolean;
      connection: { enabled: boolean; link: string };
    }>();
    expect(first.available).toBe(true);
    expect(first.connection.link).toMatch(/^https:\/\/max\.ru\/taxibot_bot\?start=[a-z0-9]{10}$/u);

    const again = await api().inject({
      method: 'POST',
      url: '/client/messages/bot',
      headers: bearer(client.token),
    });
    expect(again.json<{ connection: { link: string } }>().connection.link).toBe(
      first.connection.link,
    );

    const off = await api().inject({
      method: 'PATCH',
      url: '/client/messages/bot',
      headers: bearer(client.token),
      payload: { enabled: false },
    });
    expect(off.json<{ connection: { enabled: boolean } }>().connection.enabled).toBe(false);

    // Продукт выключен администратором — клиенту бот недоступен.
    await fx.put(adminToken, { 'bot.enabled': false });
    expect((await view(client.token)).json<{ available: boolean }>().available).toBe(false);
  });

  it('чужой клиент ссылку не видит: у каждого свой код', async () => {
    await register(adminToken, { token: 'ok-taxibot' });
    const a = await fx.clientWithMoney('1');
    const b = await fx.clientWithMoney('1');
    const post = (token: string) =>
      api().inject({ method: 'POST', url: '/client/messages/bot', headers: bearer(token) });
    const linkA = (await post(a.token)).json<{ connection: { link: string } }>().connection.link;
    const linkB = (await post(b.token)).json<{ connection: { link: string } }>().connection.link;
    expect(linkA).not.toBe(linkB);
  });
});

describe('события бота', () => {
  async function setup() {
    await register(adminToken, { token: 'ok-taxibot' });
    const client = await fx.clientWithMoney('1');
    const connected = await api().inject({
      method: 'POST',
      url: '/client/messages/bot',
      headers: bearer(client.token),
    });
    const code =
      connected.json<{ connection: { link: string } }>().connection.link.split('start=')[1] ?? '';
    return { client, code, botId: await botIdOf() };
  }

  const subscribers = () =>
    withDatabase(async (execute) => {
      const result = await execute(
        sql`select max_user_id, chat_id, phone, state from bot_subscribers order by created_at`,
      );
      return result.rows as {
        max_user_id: string;
        chat_id: string;
        phone: string | null;
        state: string;
      }[];
    });

  it('чужой или пропущенный секрет — отказ; неизвестное событие — спокойный ответ', async () => {
    const { botId } = await setup();
    expect((await event(botId, { update_type: 'bot_started' }, 'не-тот')).statusCode).toBe(403);
    const none = await api().inject({
      method: 'POST',
      url: `/webhooks/max-bot/${botId}`,
      payload: { update_type: 'bot_started' },
    });
    expect(none.statusCode).toBe(403);
    expect((await event(botId, { update_type: 'что-то_новое' })).statusCode).toBe(200);
    expect(await subscribers()).toHaveLength(0);
  });

  it('запуск по ссылке клиента создаёт подписчика и просит номер кнопкой; без ссылки — просит открыть ссылку', async () => {
    const { botId, code } = await setup();

    expect(
      (
        await event(botId, {
          update_type: 'bot_started',
          chat_id: 555,
          user: { user_id: 77 },
          payload: code,
        })
      ).statusCode,
    ).toBe(200);
    expect(await subscribers()).toEqual([
      { max_user_id: '77', chat_id: '555', phone: null, state: 'started' },
    ]);
    expect(simulatedBotSent.at(-1)).toMatchObject({
      chatId: '555',
      requestContact: 'Поделиться номером',
    });
    expect(simulatedBotSent.at(-1)?.text).toContain('Такси');

    await event(botId, {
      update_type: 'bot_started',
      chat_id: 556,
      user: { user_id: 78 },
      payload: 'нет-такого',
    });
    await event(botId, { update_type: 'bot_started', chat_id: 557, user: { user_id: 79 } });
    expect(await subscribers()).toHaveLength(1);
    expect(simulatedBotSent.at(-1)?.text).toContain('по ссылке');
  });

  it('номер принимается только из контакта, присланного о себе; чужой контакт привязки не создаёт', async () => {
    const { botId, code } = await setup();
    await event(botId, {
      update_type: 'bot_started',
      chat_id: 555,
      user: { user_id: 77 },
      payload: code,
    });

    const contact = (owner: number, tel: string) => ({
      update_type: 'message_created',
      message: {
        sender: { user_id: 77 },
        recipient: { chat_id: 555 },
        body: {
          attachments: [
            {
              type: 'contact',
              payload: {
                vcf_info: `BEGIN:VCARD\r\nTEL;TYPE=cell:${tel}\r\nEND:VCARD`,
                max_info: { user_id: owner },
              },
            },
          ],
        },
      },
    });

    // Контакт другого человека.
    await event(botId, contact(99, '+7 900 123-45-67'));
    expect((await subscribers())[0]?.phone).toBeNull();
    expect(simulatedBotSent.at(-1)?.text).toContain('своим номером');

    // Свой контакт: номер приводится к одиннадцати цифрам.
    await event(botId, contact(77, '+7 (900) 123-45-67'));
    expect((await subscribers())[0]?.phone).toBe('79001234567');
    expect(simulatedBotSent.at(-1)?.text).toContain('подтверждён');

    const client = await withDatabase(async (execute) => {
      const result = await execute(sql`select client_id from bot_connections limit 1`);
      return (result.rows[0] as { client_id: string }).client_id;
    });
    const counted = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as n from bot_subscribers where client_id = ${client} and phone is not null`,
      );
      return (result.rows[0] as { n: number }).n;
    });
    expect(counted).toBe(1);
  });

  it('«СТОП» отписывает, повторный запуск по ссылке возвращает подписку', async () => {
    const { botId, code } = await setup();
    const start = {
      update_type: 'bot_started',
      chat_id: 555,
      user: { user_id: 77 },
      payload: code,
    };
    await event(botId, start);

    await event(botId, {
      update_type: 'message_created',
      message: { sender: { user_id: 77 }, recipient: { chat_id: 555 }, body: { text: ' Стоп ' } },
    });
    expect((await subscribers())[0]?.state).toBe('stopped');
    expect(simulatedBotSent.at(-1)?.text).toContain('остановлены');

    await event(botId, start);
    expect((await subscribers())[0]?.state).toBe('started');
  });

  it('отключённый клиент и отключённый бот не принимают подписчиков', async () => {
    const { botId, code, client } = await setup();
    await api().inject({
      method: 'PATCH',
      url: '/client/messages/bot',
      headers: bearer(client.token),
      payload: { enabled: false },
    });
    await event(botId, {
      update_type: 'bot_started',
      chat_id: 555,
      user_id: 1,
      user: { user_id: 77 },
      payload: code,
    });
    expect(await subscribers()).toHaveLength(0);

    await api().inject({
      method: 'PATCH',
      url: '/client/messages/bot',
      headers: bearer(client.token),
      payload: { enabled: true },
    });
    await api().inject({
      method: 'POST',
      url: '/bots/platform/disable',
      headers: bearer(adminToken),
    });
    await event(botId, {
      update_type: 'bot_started',
      chat_id: 555,
      user: { user_id: 77 },
      payload: code,
    });
    expect(await subscribers()).toHaveLength(0);
  });
});
