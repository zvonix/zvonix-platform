/**
 * Бот MAX (ADR-0077, этап 2): клиент подключает своего бота — вставляет токен, площадка проверяет его и настраивает
 * приём событий; сообщения идут через него по условиям «своих» ботов; бот площадки и свой не смешиваются.
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
import { MessagesService } from '../messages.service.js';
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
    await execute(sql`delete from messages`);
    await execute(sql`delete from messenger_accounts`);
    await execute(sql`delete from bot_subscribers`);
    await execute(sql`delete from bot_connections`);
    await execute(sql`delete from messenger_bots`);
  });
  simulatedBotSent.length = 0;
  simulatedBotSubscriptions.clear();
  expect(
    (
      await fx.put(adminToken, {
        'messaging.enabled': true,
        'bot.enabled': true,
        'bot.message_price': 0.25,
        'bot.monthly_fee': 0,
        'bot.own_message_price': 0.1,
        'bot.own_monthly_fee': 0,
        'messages.pace_seconds': 0,
      })
    ).statusCode,
  ).toBe(200);
});

afterAll(async () => {
  await app?.close();
});

interface BotView {
  available: boolean;
  platform_available: boolean;
  connection: { enabled: boolean; kind: string; link: string; fee_paid: boolean } | null;
  terms: { message_price: string; monthly_fee: string };
  own: {
    bot: { name: string; username: string; status: string } | null;
    terms: { message_price: string; monthly_fee: string };
  };
}

const registerOwn = (token: string, payload: Record<string, unknown>) =>
  api().inject({
    method: 'PUT',
    url: '/client/messages/bot/own',
    headers: bearer(token),
    payload,
  });

const viewOf = async (token: string): Promise<BotView> =>
  (
    await api().inject({ method: 'GET', url: '/client/messages/bot', headers: bearer(token) })
  ).json<BotView>();

const botIdOf = (kind: string): Promise<string> =>
  withDatabase(async (execute) => {
    const result = await execute(sql`select id from messenger_bots where kind = ${kind} limit 1`);
    return (result.rows[0] as { id: string }).id;
  });

async function event(botId: string, body: Record<string, unknown>) {
  return api().inject({
    method: 'POST',
    url: `/webhooks/max-bot/${botId}`,
    headers: { 'x-max-bot-api-secret': api().get(BotsService).webhookSecret(botId) },
    payload: body,
  });
}

/** Человек запускает бота по ссылке клиента и делится номером. */
async function subscribe(botId: string, link: string, user: number, chat: number, phone: string) {
  await event(botId, {
    update_type: 'bot_started',
    chat_id: chat,
    user: { user_id: user },
    payload: link.split('start=')[1],
  });
  await event(botId, {
    update_type: 'message_created',
    message: {
      sender: { user_id: user },
      recipient: { chat_id: chat },
      body: {
        attachments: [
          {
            type: 'contact',
            payload: { vcf_info: `TEL;TYPE=cell:+${phone}`, max_info: { user_id: user } },
          },
        ],
      },
    },
  });
}

const sendTo = (token: string, to: string) =>
  api().inject({
    method: 'POST',
    url: '/client/messages',
    headers: bearer(token),
    payload: { to, text: 'Машина подана' },
  });

describe('свой бот клиента', () => {
  it('токен проверяется у MAX и нигде не показывается; подключение идёт через свой бот; никнейм в ссылке свой', async () => {
    const client = await fx.clientWithMoney('10');

    expect((await registerOwn(client.token, { token: 'чужой-токен' })).statusCode).toBe(400);
    expect((await registerOwn(client.token, { token: ' ' })).statusCode).toBe(400);

    const ok = await registerOwn(client.token, { token: 'ok-romashka' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain('ok-romashka');
    const view = ok.json<BotView>();
    expect(view.own.bot).toMatchObject({ username: 'romashka_bot', status: 'active' });
    expect(view.connection).toMatchObject({ enabled: true, kind: 'own' });
    expect(view.connection?.link).toMatch(/^https:\/\/max\.ru\/romashka_bot\?start=[a-z0-9]{10}$/u);
    // Условия — для своих ботов, а не для бота площадки.
    expect(view.terms.message_price).toBe('0.1');
    expect(view.own.terms.message_price).toBe('0.1');

    // Вебхук настроен на бота клиента с его секретом.
    const id = await botIdOf('client');
    expect(simulatedBotSubscriptions.get('ok-romashka')?.secret).toBe(
      api().get(BotsService).webhookSecret(id),
    );

    // Повтор заменяет токен у того же бота.
    expect((await registerOwn(client.token, { token: 'ok-romashka' })).statusCode).toBe(200);
    expect(await botIdOf('client')).toBe(id);
  });

  it('подписчик своего бота получает сообщение от него по цене своих ботов; подписчик площадки — нет', async () => {
    const platform = await api().inject({
      method: 'PUT',
      url: '/bots/platform',
      headers: bearer(adminToken),
      payload: { token: 'ok-taxibot' },
    });
    expect(platform.statusCode).toBe(200);
    const client = await fx.clientWithMoney('10');
    const view = (await registerOwn(client.token, { token: 'ok-romashka' })).json<BotView>();
    const ownBot = await botIdOf('client');
    await subscribe(ownBot, view.connection?.link ?? '', 77, 555, '79001234567');
    simulatedBotSent.length = 0;

    const id = (await sendTo(client.token, '79001234567')).json<{ message: { id: string } }>()
      .message.id;
    expect(await fx.balance(client.token)).toBe('9.9');
    await api().get(MessagesService).dispatchDue(new Date());
    expect(simulatedBotSent).toHaveLength(1);
    expect(simulatedBotSent[0]).toMatchObject({ token: 'ok-romashka', chatId: '555' });
    const sent = (
      await api().inject({
        method: 'GET',
        url: '/client/messages?limit=50',
        headers: bearer(client.token),
      })
    ).json<{ messages: { id: string; status: string }[] }>();
    expect(sent.messages.find((row) => row.id === id)?.status).toBe('delivered');

    // Сообщение подписчику площадки (другой бот) через свой бот не идёт — у номера нет подписчика в своём боте.
    await fx.partnerWithAccount('0.45');
    const platformBot = await botIdOf('platform');
    expect(platformBot).not.toBe(ownBot);
    await subscribe(platformBot, view.connection?.link ?? '', 88, 666, '79005550088');
    simulatedBotSent.length = 0;
    await sendTo(client.token, '79005550088');
    await api().get(MessagesService).dispatchDue(new Date());
    expect(simulatedBotSent.filter((item) => item.chatId === '666')).toHaveLength(0);
  });

  it('можно перейти с бота площадки на свой и обратно; подписчики остаются при своём боте', async () => {
    await api().inject({
      method: 'PUT',
      url: '/bots/platform',
      headers: bearer(adminToken),
      payload: { token: 'ok-taxibot' },
    });
    const client = await fx.clientWithMoney('10');
    const onPlatform = (
      await api().inject({
        method: 'POST',
        url: '/client/messages/bot',
        headers: bearer(client.token),
      })
    ).json<BotView>();
    expect(onPlatform.connection).toMatchObject({ kind: 'platform' });
    expect(onPlatform.terms.message_price).toBe('0.25');

    const own = (await registerOwn(client.token, { token: 'ok-romashka' })).json<BotView>();
    expect(own.connection).toMatchObject({ kind: 'own' });
    expect(own.terms.message_price).toBe('0.1');

    const back = (
      await api().inject({
        method: 'POST',
        url: '/client/messages/bot',
        headers: bearer(client.token),
      })
    ).json<BotView>();
    expect(back.connection).toMatchObject({ kind: 'platform', enabled: true });
    expect(back.own.bot?.username).toBe('romashka_bot');
  });

  it('отключение своего бота снимает подписку у MAX и выключает подключение; токен нельзя прочитать из ответов', async () => {
    const client = await fx.clientWithMoney('10');
    await registerOwn(client.token, { token: 'ok-romashka' });
    expect(simulatedBotSubscriptions.has('ok-romashka')).toBe(true);

    const removed = await api().inject({
      method: 'DELETE',
      url: '/client/messages/bot/own',
      headers: bearer(client.token),
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<BotView>().own.bot?.status).toBe('disabled');
    expect(removed.json<BotView>().connection?.enabled).toBe(false);
    expect(simulatedBotSubscriptions.has('ok-romashka')).toBe(false);
    expect(removed.body).not.toContain('ok-romashka');

    // Включить отключённого бота нельзя: подключитесь заново.
    const enable = await api().inject({
      method: 'PATCH',
      url: '/client/messages/bot',
      headers: bearer(client.token),
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(409);

    // Повторное удаление — нет такого бота.
    const stranger = await fx.clientWithMoney('1');
    expect(
      (
        await api().inject({
          method: 'DELETE',
          url: '/client/messages/bot/own',
          headers: bearer(stranger.token),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('плата за своего бота: не хватает денег — подключения нет; хватает — берётся по условиям своих ботов', async () => {
    await fx.put(adminToken, { 'bot.own_monthly_fee': 3 });
    const poor = await fx.clientWithMoney('1');
    const refused = await registerOwn(poor.token, { token: 'ok-poorbot' });
    expect(refused.statusCode).toBe(409);
    expect((await viewOf(poor.token)).connection).toBeNull();
    expect(await fx.balance(poor.token)).toBe('1');

    const rich = await fx.clientWithMoney('10');
    const ok = await registerOwn(rich.token, { token: 'ok-richbot' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<BotView>().connection?.fee_paid).toBe(true);
    expect(await fx.balance(rich.token)).toBe('7');
  });

  it('чужой токен и чужой клиент: свой бот привязан к клиенту; администратор видит вид бота в списке', async () => {
    const a = await fx.clientWithMoney('10');
    const b = await fx.clientWithMoney('10');
    await registerOwn(a.token, { token: 'ok-abot' });
    await registerOwn(b.token, { token: 'ok-bbot' });
    expect((await viewOf(a.token)).own.bot?.username).toBe('abot_bot');
    expect((await viewOf(b.token)).own.bot?.username).toBe('bbot_bot');

    const list = await api().inject({
      method: 'GET',
      url: '/bots/platform/clients',
      headers: bearer(adminToken),
    });
    const bots = list
      .json<{ clients: { bot: { kind: string; username: string } }[] }>()
      .clients.map((row) => `${row.bot.kind}:${row.bot.username}`)
      .sort();
    expect(bots).toEqual(['own:abot_bot', 'own:bbot_bot']);

    // Продукт выключен — зарегистрировать нельзя.
    await fx.put(adminToken, { 'bot.enabled': false });
    expect((await registerOwn(a.token, { token: 'ok-abot' })).statusCode).toBe(409);
  });

  it('аккаунтов партнёров нет, но бот работает — форма отправки показывает цену бота, а не «некуда»', async () => {
    const client = await fx.clientWithMoney('10');
    const price = () =>
      api()
        .inject({ method: 'GET', url: '/client/messages/price', headers: bearer(client.token) })
        .then((response) => response.json<{ price: string | null }>().price);

    expect(await price()).toBeNull();
    await registerOwn(client.token, { token: 'ok-romashka' });
    expect(await price()).toBe('0.1');
  });
});
