/**
 * Бот MAX (ADR-0077, этап 1б): сообщение подписчику уходит от бота, деньги идут площадке, отказ возвращает их,
 * номер без подписчика идёт через аккаунты партнёров. Платформа подменена имитацией.
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
import { simulatedBotSent } from './simulated-bot.provider.js';

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
    await execute(sql`delete from bot_subscribers`);
    await execute(sql`delete from bot_connections`);
    await execute(sql`delete from messenger_bots`);
  });
  simulatedBotSent.length = 0;
  expect(
    (
      await fx.put(adminToken, {
        'messaging.enabled': true,
        'bot.enabled': true,
        'messages.pace_seconds': 0,
      })
    ).statusCode,
  ).toBe(200);
});

afterAll(async () => {
  await app?.close();
});

const botIdOf = (): Promise<string> =>
  withDatabase(async (execute) => {
    const result = await execute(sql`select id from messenger_bots limit 1`);
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

const sendTo = (token: string, to: string, extra: Record<string, unknown> = {}) =>
  api().inject({
    method: 'POST',
    url: '/client/messages',
    headers: bearer(token),
    payload: { to, text: 'Машина подана', ...extra },
  });

interface Sent {
  id: string;
  status: string;
  failure_reason: string | null;
  cost: string | null;
}

const messageOf = async (token: string, id: string): Promise<Sent | undefined> =>
  (await api().inject({ method: 'GET', url: '/client/messages?limit=200', headers: bearer(token) }))
    .json<{ messages: Sent[] }>()
    .messages.find((row) => row.id === id);

const idOf = (response: Awaited<ReturnType<NestFastifyApplication['inject']>>): string =>
  response.json<{ message: { id: string } }>().message.id;

const dispatch = async (): Promise<void> => {
  await api().get(MessagesService).dispatchDue(new Date());
};

/** Бот, клиент с деньгами и подписчик с номером: человек запустил бота и поделился контактом. */
async function subscribed(chat = 555, user = 77, phone = '79001234567') {
  const registered = await api().inject({
    method: 'PUT',
    url: '/bots/platform',
    headers: bearer(adminToken),
    payload: { token: 'ok-taxibot' },
  });
  expect(registered.statusCode).toBe(200);
  const client = await fx.clientWithMoney('10');
  const connected = await api().inject({
    method: 'POST',
    url: '/client/messages/bot',
    headers: bearer(client.token),
  });
  const code =
    connected.json<{ connection: { link: string } }>().connection.link.split('start=')[1] ?? '';
  const botId = await botIdOf();
  await event(botId, {
    update_type: 'bot_started',
    chat_id: chat,
    user: { user_id: user },
    payload: code,
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
  simulatedBotSent.length = 0;
  return { client, botId, phone };
}

describe('отправка ботом и деньги', () => {
  it('подписчику уходит от бота: цена площадки списана, сообщение доставлено, партнёр не нужен', async () => {
    expect((await fx.put(adminToken, { 'bot.message_price': 0.25 })).statusCode).toBe(200);
    const { client, phone } = await subscribed();

    const accepted = await sendTo(client.token, phone);
    expect(accepted.statusCode).toBe(201);
    const id = idOf(accepted);
    expect(await fx.balance(client.token)).toBe('9.75');

    await dispatch();
    expect(simulatedBotSent).toHaveLength(1);
    expect(simulatedBotSent[0]).toMatchObject({ chatId: '555', text: 'Машина подана' });
    expect(await messageOf(client.token, id)).toMatchObject({ status: 'delivered', cost: '0.25' });

    // Сотрудник видит маршрут «бот» и деньги целиком у площадки.
    const staff = await api().inject({
      method: 'GET',
      url: '/messages',
      headers: bearer(adminToken),
    });
    const row = staff
      .json<{
        messages: {
          id: string;
          route: string;
          partner_id: string | null;
          money: Record<string, string>;
        }[];
      }>()
      .messages.find((item) => item.id === id);
    expect(row).toMatchObject({
      route: 'bot',
      partner_id: null,
      money: { client: '0.25', partner: '0', margin: '0.25' },
    });
  });

  it('цена 0 — бесплатно: деньги не двигаются, сообщение всё равно уходит', async () => {
    expect((await fx.put(adminToken, { 'bot.message_price': 0 })).statusCode).toBe(200);
    const { client, phone } = await subscribed();

    const id = idOf(await sendTo(client.token, phone));
    expect(await fx.balance(client.token)).toBe('10');
    await dispatch();
    expect(await messageOf(client.token, id)).toMatchObject({ status: 'delivered' });
    expect(simulatedBotSent).toHaveLength(1);
  });

  it('тот же ключ повторно — одно сообщение и одно списание', async () => {
    await fx.put(adminToken, { 'bot.message_price': 0.25 });
    const { client, phone } = await subscribed();
    const first = await sendTo(client.token, phone, { externalId: 'order-1' });
    const second = await sendTo(client.token, phone, { externalId: 'order-1' });
    expect(idOf(second)).toBe(idOf(first));
    expect(await fx.balance(client.token)).toBe('9.75');
  });

  it('подписчик остановил бота до отправки — отказ с возвратом, сообщение не уходит', async () => {
    await fx.put(adminToken, { 'bot.message_price': 0.25 });
    const { client, botId, phone } = await subscribed();
    const id = idOf(await sendTo(client.token, phone));
    expect(await fx.balance(client.token)).toBe('9.75');

    await event(botId, {
      update_type: 'message_created',
      message: { sender: { user_id: 77 }, recipient: { chat_id: 555 }, body: { text: 'СТОП' } },
    });
    simulatedBotSent.length = 0;
    await dispatch();
    expect(await messageOf(client.token, id)).toMatchObject({
      status: 'failed',
      failure_reason: 'recipient_not_in_max',
    });
    expect(await fx.balance(client.token)).toBe('10');
    expect(simulatedBotSent.filter((item) => item.text === 'Машина подана')).toHaveLength(0);
  });

  it('MAX отказал (чат закрыт) — возврат, подписчик помечен остановленным', async () => {
    await fx.put(adminToken, { 'bot.message_price': 0.25 });
    // Чат на 0000: имитация отвечает «получатель недоступен».
    const { client, phone } = await subscribed(1110000, 78, '79005550078');
    const id = idOf(await sendTo(client.token, phone));
    await dispatch();
    expect(await messageOf(client.token, id)).toMatchObject({
      status: 'failed',
      failure_reason: 'recipient_not_in_max',
    });
    expect(await fx.balance(client.token)).toBe('10');
    const state = await withDatabase(async (execute) => {
      const result = await execute(sql`select state from bot_subscribers where max_user_id = '78'`);
      return (result.rows[0] as { state: string }).state;
    });
    expect(state).toBe('stopped');
  });

  it('номера без подписчика идут обычным путём через аккаунты партнёров', async () => {
    await fx.put(adminToken, { 'bot.message_price': 0.25 });
    const { client } = await subscribed();
    await fx.partnerWithAccount('0.45');

    const id = idOf(await sendTo(client.token, '79005550099'));
    // Цена через аккаунт партнёра (0.45 и наценка площадки) — а не цена бота (0.25).
    expect(await fx.balance(client.token)).toBe('9.46');
    await dispatch();
    expect(simulatedBotSent).toHaveLength(0);
    expect((await messageOf(client.token, id))?.status).not.toBe('failed');
  });

  it('клиент отключил бота — номер идёт через аккаунты, а не ботом', async () => {
    await fx.put(adminToken, { 'bot.message_price': 0.25 });
    const { client, phone } = await subscribed();
    await fx.partnerWithAccount('0.45');
    await api().inject({
      method: 'PATCH',
      url: '/client/messages/bot',
      headers: bearer(client.token),
      payload: { enabled: false },
    });

    await sendTo(client.token, phone);
    expect(await fx.balance(client.token)).toBe('9.46');
    await dispatch();
    expect(simulatedBotSent).toHaveLength(0);
  });
});
