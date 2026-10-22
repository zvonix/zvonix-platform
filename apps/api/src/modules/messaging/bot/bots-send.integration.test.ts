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
    await execute(sql`delete from message_stops`);
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
        // Тесты шлют один и тот же текст одному номеру много раз: защита от повторов отключена (проверяется отдельно).
        'messages.duplicate_window_minutes': 0,
        'messages.recipient_limit_per_hour': 0,
        'messages.recipient_limit_per_day': 0,
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
async function subscribed(chat = 555, user = 77, phone = '79001234567', name?: string) {
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
    user: { user_id: user, ...(name === undefined ? {} : { first_name: name }) },
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
      failure_reason: 'recipient_stopped',
    });
    expect(await fx.balance(client.token)).toBe('10');
    expect(simulatedBotSent.filter((item) => item.text === 'Машина подана')).toHaveLength(0);
    // «СТОП» боту — отказ и для аккаунтов партнёров: номер в общем списке «не писать» (ADR-0088).
    const listed = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select source, client_id as "clientId" from message_stops where phone = ${phone}`,
      );
      return result.rows as { source: string; clientId: string | null }[];
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.source).toBe('bot');
    expect(listed[0]?.clientId).not.toBeNull();
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

  it('остановка бота (bot_stopped): по умолчанию — только бот перестаёт писать; с настройкой — номер в «Не писать» (ADR-0091)', async () => {
    const stopsOf = (phone: string) =>
      withDatabase(async (execute) => {
        const result = await execute(
          sql`select source, client_id as "clientId" from message_stops where phone = ${phone}`,
        );
        return result.rows as { source: string; clientId: string | null }[];
      });
    const stateOf = (user: string) =>
      withDatabase(async (execute) => {
        const result = await execute(
          sql`select state from bot_subscribers where max_user_id = ${user}`,
        );
        return (result.rows[0] as { state: string }).state;
      });

    const off = await subscribed(561, 81, '79005550081');
    await event(off.botId, { update_type: 'bot_stopped', chat_id: 561, user: { user_id: 81 } });
    expect(await stateOf('81')).toBe('stopped');
    expect(await stopsOf(off.phone)).toHaveLength(0);

    expect((await fx.put(adminToken, { 'bot.block_stops_accounts': true })).statusCode).toBe(200);
    try {
      const on = await subscribed(562, 82, '79005550082');
      await event(on.botId, { update_type: 'dialog_removed', chat_id: 562, user: { user_id: 82 } });
      expect(await stateOf('82')).toBe('stopped');
      expect(await stopsOf(on.phone)).toMatchObject([{ source: 'bot' }]);
      expect((await stopsOf(on.phone))[0]?.clientId).not.toBeNull();

      // Блокировка, замеченная по отказу MAX при отправке, — тоже запрет.
      const rejected = await subscribed(1120000, 83, '79005550083');
      await sendTo(rejected.client.token, rejected.phone);
      await dispatch();
      expect(await stopsOf(rejected.phone)).toMatchObject([{ source: 'bot' }]);
    } finally {
      await fx.put(adminToken, { 'bot.block_stops_accounts': false });
    }
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

describe('плата за бота и условия клиента', () => {
  const connect = (token: string) =>
    api().inject({ method: 'POST', url: '/client/messages/bot', headers: bearer(token) });

  const termsPatch = (token: string, clientId: string, payload: Record<string, unknown>) =>
    api().inject({
      method: 'PATCH',
      url: `/bots/platform/clients/${clientId}`,
      headers: bearer(token),
      payload,
    });

  const registerBot = async () => {
    const registered = await api().inject({
      method: 'PUT',
      url: '/bots/platform',
      headers: bearer(adminToken),
      payload: { token: 'ok-taxibot' },
    });
    expect(registered.statusCode).toBe(200);
  };

  const feeEntries = (clientId: string): Promise<number> =>
    withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as n from ledger_transactions where idempotency_key like ${`bot_fee:${clientId}:%`}`,
      );
      return (result.rows[0] as { n: number }).n;
    });

  it('плата берётся при подключении один раз за месяц; повторное подключение и выключение-включение не списывают', async () => {
    await fx.put(adminToken, { 'bot.monthly_fee': 1.5 });
    await registerBot();
    const client = await fx.clientWithMoney('10');

    const first = await connect(client.token);
    expect(first.statusCode).toBe(201);
    expect(
      first.json<{ terms: { monthly_fee: string }; connection: { fee_paid: boolean } }>(),
    ).toMatchObject({
      terms: { monthly_fee: '1.5' },
      connection: { fee_paid: true },
    });
    expect(await fx.balance(client.token)).toBe('8.5');

    await connect(client.token);
    for (const enabled of [false, true]) {
      await api().inject({
        method: 'PATCH',
        url: '/client/messages/bot',
        headers: bearer(client.token),
        payload: { enabled },
      });
    }
    expect(await fx.balance(client.token)).toBe('8.5');
    expect(await feeEntries(client.clientId)).toBe(1);
  });

  it('не хватает денег на плату — подключения нет, счёт не тронут', async () => {
    await fx.put(adminToken, { 'bot.monthly_fee': 5 });
    await registerBot();
    const poor = await fx.clientWithMoney('0');

    const refused = await connect(poor.token);
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('Не хватает денег');
    expect(await fx.balance(poor.token)).toBe('0');
    const view = await api().inject({
      method: 'GET',
      url: '/client/messages/bot',
      headers: bearer(poor.token),
    });
    expect(view.json<{ connection: unknown }>().connection).toBeNull();
  });

  it('новый месяц: воркер берёт плату сам, повторный проход ничего не списывает; без денег ждёт пополнения', async () => {
    await fx.put(adminToken, { 'bot.monthly_fee': 1.5 });
    await registerBot();
    const client = await fx.clientWithMoney('2');
    await connect(client.token);
    expect(await fx.balance(client.token)).toBe('0.5');

    const bots = api().get(BotsService);
    const nextMonth = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 2),
    );
    // Денег на новый месяц нет: плата не взята, счёт не тронут.
    expect(await bots.chargeFees(nextMonth)).toBe(0);
    expect(await fx.balance(client.token)).toBe('0.5');
    expect(await feeEntries(client.clientId)).toBe(1);

    // Пополнили — следующий проход берёт плату; ещё один ничего не добавляет.
    await api().inject({
      method: 'POST',
      url: `/clients/${client.clientId}/deposit`,
      headers: bearer(adminToken),
      payload: { amount: '5', idempotencyKey: `top-${client.clientId}`, description: 'Пополнение' },
    });
    expect(await bots.chargeFees(nextMonth)).toBe(1);
    expect(await fx.balance(client.token)).toBe('4');
    expect(await bots.chargeFees(nextMonth)).toBe(0);
    expect(await fx.balance(client.token)).toBe('4');
    expect(await feeEntries(client.clientId)).toBe(2);
  });

  it('плата за месяц не взята — бот не отправляет, сообщение идёт через аккаунт партнёра', async () => {
    await fx.put(adminToken, { 'bot.message_price': 0.25, 'bot.monthly_fee': 1 });
    const { client, phone } = await subscribed();
    await fx.partnerWithAccount('0.45');
    // Подписчик есть и подключён, но плата за месяц не взята.
    await withDatabase(async (execute) => {
      await execute(sql`update bot_connections set fee_paid_period = null`);
    });

    // Из десяти: плата за бота 1 при подключении и 0.54 за сообщение через аккаунт.
    const id = idOf(await sendTo(client.token, phone));
    expect(await fx.balance(client.token)).toBe('8.46');
    await dispatch();
    expect(simulatedBotSent).toHaveLength(0);
    expect((await messageOf(client.token, id))?.status).not.toBe('failed');
  });

  it('администратор задаёт клиенту свои условия: бесплатно или другая цена; «как у всех» возвращает общие; пишется в журнал', async () => {
    await fx.put(adminToken, { 'bot.message_price': 0.25, 'bot.monthly_fee': 0 });
    const { client, phone } = await subscribed();
    const support = await fx.user('support');

    expect(
      (await termsPatch(support.token, client.clientId, { messagePrice: '0' })).statusCode,
    ).toBe(403);
    expect((await termsPatch(adminToken, client.clientId, {})).statusCode).toBe(400);
    expect((await termsPatch(adminToken, client.clientId, { messagePrice: '-1' })).statusCode).toBe(
      400,
    );
    expect(
      (await termsPatch(adminToken, client.clientId, { messagePrice: '5000' })).statusCode,
    ).toBe(400);
    expect(
      (await termsPatch(adminToken, client.clientId, { monthlyFee: 'много' })).statusCode,
    ).toBe(400);

    const free = await termsPatch(adminToken, client.clientId, { messagePrice: '0' });
    expect(free.statusCode).toBe(200);
    expect(
      free.json<{
        clients: { own: { message_price: string | null }; terms: { message_price: string } }[];
      }>().clients[0],
    ).toMatchObject({ own: { message_price: '0' }, terms: { message_price: '0' } });

    await sendTo(client.token, phone);
    expect(await fx.balance(client.token)).toBe('10');

    const back = await termsPatch(adminToken, client.clientId, { messagePrice: null });
    expect(
      back.json<{ clients: { terms: { message_price: string } }[] }>().clients[0]?.terms
        .message_price,
    ).toBe('0.25');
    await sendTo(client.token, phone);
    expect(await fx.balance(client.token)).toBe('9.75');

    const list = await api().inject({
      method: 'GET',
      url: '/bots/platform/clients',
      headers: bearer(support.token),
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json<{ clients: { client_name: string; subscribers: number }[] }>().clients[0],
    ).toMatchObject({
      subscribers: 1,
    });

    const logged = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as n from audit_log where action = 'bot_connection.terms_changed'`,
      );
      return (result.rows[0] as { n: number }).n;
    });
    expect(logged).toBe(2);
  });
});

describe('настройки бота клиента и шаблон сообщения (этап 3, ADR-0087)', () => {
  const settingsPatch = (token: string, payload: Record<string, unknown>) =>
    api().inject({
      method: 'PATCH',
      url: '/client/messages/bot/settings',
      headers: bearer(token),
      payload,
    });

  const connectPlatform = async () => {
    const registered = await api().inject({
      method: 'PUT',
      url: '/bots/platform',
      headers: bearer(adminToken),
      payload: { token: 'ok-taxibot' },
    });
    expect(registered.statusCode).toBe(200);
    await fx.put(adminToken, { 'bot.message_price': 0, 'bot.monthly_fee': 0 });
  };

  it('настройки сохраняются, пустая строка возвращает стандартный текст, слишком длинное и чужое отвергается', async () => {
    await connectPlatform();
    const client = await fx.clientWithMoney('5');
    // Пока не подключён к боту — нечего настраивать.
    expect((await settingsPatch(client.token, { greeting: 'Привет' })).statusCode).toBe(404);

    await api().inject({
      method: 'POST',
      url: '/client/messages/bot',
      headers: bearer(client.token),
    });
    expect((await settingsPatch(client.token, {})).statusCode).toBe(400);
    expect((await settingsPatch(client.token, { greeting: 'я'.repeat(301) })).statusCode).toBe(400);

    const saved = await settingsPatch(client.token, {
      greeting: '  Здравствуйте! Вас приветствует {служба}  ',
      fallbackAccounts: false,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ settings: Record<string, unknown> }>().settings).toEqual({
      greeting: 'Здравствуйте! Вас приветствует {служба}',
      fallback_accounts: false,
      share_button: '📲 Получать уведомления',
    });

    const cleared = await settingsPatch(client.token, { greeting: '' });
    expect(cleared.json<{ settings: Record<string, unknown> }>().settings).toMatchObject({
      greeting: null,
      fallback_accounts: false,
      share_button: '📲 Получать уведомления',
    });
  });

  const putTemplate = (token: string, blocks: unknown[]) =>
    api().inject({
      method: 'PUT',
      url: '/client/messages/template',
      headers: bearer(token),
      payload: { blocks },
    });

  it('шаблон: без него сообщение как написано; блоки собираются в порядке; слишком длинное уходит без вставок', async () => {
    await connectPlatform();
    const { client, phone } = await subscribed();
    const initial = await api().inject({
      method: 'GET',
      url: '/client/messages/template',
      headers: bearer(client.token),
    });
    const initialBody = initial.json<{ blocks: unknown; company: string }>();
    expect(initialBody.blocks).toEqual([{ kind: 'body', when: 'always' }]);
    expect(initialBody.company).toMatch(/^Такси /u);

    expect(
      (
        await putTemplate(client.token, [
          { kind: 'text', text: 'Такси Волна:', when: 'always' },
          { kind: 'body', when: 'always' },
          { kind: 'text', text: 'СТОП — отписаться', when: 'always' },
        ])
      ).statusCode,
    ).toBe(200);

    await sendTo(client.token, phone);
    await api().get(MessagesService).dispatchDue(new Date());
    expect(simulatedBotSent.at(-1)?.text).toBe('Такси Волна:\nМашина подана\nСТОП — отписаться');

    const long = 'я'.repeat(3990);
    await api().inject({
      method: 'POST',
      url: '/client/messages',
      headers: bearer(client.token),
      payload: { to: phone, text: long },
    });
    await api().get(MessagesService).dispatchDue(new Date());
    expect(simulatedBotSent.at(-1)?.text).toBe(long);
  });

  it('шаблон отвергает неверный состав: нет текста клиента, два текста клиента, пустой блок, слишком много, чужое поле', async () => {
    await connectPlatform();
    const client = await fx.clientWithMoney('5');
    const body = { kind: 'body', when: 'always' };
    expect((await putTemplate(client.token, [])).statusCode).toBe(400);
    expect(
      (await putTemplate(client.token, [{ kind: 'text', text: 'а', when: 'always' }])).statusCode,
    ).toBe(400);
    expect((await putTemplate(client.token, [body, body])).statusCode).toBe(400);
    expect(
      (await putTemplate(client.token, [body, { kind: 'text', text: '  ', when: 'always' }]))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await putTemplate(client.token, [
          body,
          { kind: 'text', text: 'я'.repeat(301), when: 'always' },
        ])
      ).statusCode,
    ).toBe(400);
    expect(
      (await putTemplate(client.token, [body, { kind: 'body', when: 'first' }])).statusCode,
    ).toBe(400);
    expect((await putTemplate(client.token, [{ ...body, extra: 1 }])).statusCode).toBe(400);
    expect(
      (
        await putTemplate(
          client.token,
          Array.from({ length: 13 }, (_unused, index) =>
            index === 0 ? body : { kind: 'text', text: 'а', when: 'always' },
          ),
        )
      ).statusCode,
    ).toBe(400);
  });

  it('приветствие с именем из профиля MAX, «только первое» и ссылка на бота', async () => {
    await connectPlatform();
    const { client, phone } = await subscribed(556, 78, '79001234568', 'Иван');
    expect(
      (
        await putTemplate(client.token, [
          { kind: 'greeting', text: 'Здравствуйте, {имя}!', when: 'always' },
          { kind: 'body', when: 'always' },
          { kind: 'text', text: 'Мы теперь и в MAX', when: 'first' },
          { kind: 'bot_link', when: 'always' },
        ])
      ).statusCode,
    ).toBe(200);
    const link = (
      await api().inject({
        method: 'GET',
        url: '/client/messages/bot',
        headers: bearer(client.token),
      })
    ).json<{ connection: { link: string } }>().connection.link;

    const first = await sendTo(client.token, phone);
    expect(first.statusCode).toBe(201);
    await api().get(MessagesService).dispatchDue(new Date());
    expect(simulatedBotSent.at(-1)?.text).toBe(
      `Здравствуйте, Иван!\nМашина подана\nМы теперь и в MAX\n${link}`,
    );

    // Второе сообщение тому же человеку: блок «только первое» уже не нужен.
    const second = await sendTo(client.token, phone, { text: 'Машина у подъезда' });
    expect(second.statusCode).toBe(201);
    await api().get(MessagesService).dispatchDue(new Date());
    expect(simulatedBotSent.at(-1)?.text).toBe(`Здравствуйте, Иван!\nМашина у подъезда\n${link}`);
  });

  it('«только первое» считается по пути: первое через бота — после подписки, сколько бы ни ушло через аккаунты', async () => {
    await connectPlatform();
    await fx.partnerWithAccount('0.45');
    const { client, phone } = await subscribed(557, 79, '79001234569', 'Иван');
    expect(
      (
        await putTemplate(client.token, [
          { kind: 'body', when: 'always' },
          { kind: 'text', text: 'Промокод 2233', when: 'first', via: 'bot' },
        ])
      ).statusCode,
    ).toBe(200);
    const setState = (state: string) =>
      withDatabase(async (execute) => {
        await execute(sql`update bot_subscribers set state = ${state} where max_user_id = '79'`);
      });

    // Пока человек не подписан — сообщение уходит через аккаунт партнёра.
    await setState('stopped');
    expect((await sendTo(client.token, phone, { text: 'Через аккаунт' })).statusCode).toBe(201);
    await dispatch();
    expect(simulatedBotSent).toHaveLength(0);

    // Подписался — первое сообщение через бота всё равно «первое».
    await setState('started');
    expect((await sendTo(client.token, phone, { text: 'Машина подана' })).statusCode).toBe(201);
    await dispatch();
    expect(simulatedBotSent.at(-1)?.text).toBe('Машина подана\nПромокод 2233');

    expect((await sendTo(client.token, phone, { text: 'Машина у подъезда' })).statusCode).toBe(201);
    await dispatch();
    expect(simulatedBotSent.at(-1)?.text).toBe('Машина у подъезда');
  });

  it('статистика «бот или аккаунты»: люди в боте и сообщения по путям — у клиента и в отчёте админа (ADR-0094)', async () => {
    await connectPlatform();
    await fx.partnerWithAccount('0.45');
    const { client, phone } = await subscribed(558, 84, '79001234570');
    const setState = (state: string) =>
      withDatabase(async (execute) => {
        await execute(sql`update bot_subscribers set state = ${state} where max_user_id = '84'`);
      });
    await setState('stopped');
    await sendTo(client.token, phone, { text: 'Через аккаунт' });
    await sendTo(client.token, '79005550099', { text: 'Через аккаунт другому' });
    await dispatch();
    // Второе через тот же аккаунт ждёт паузу между отправками — время вперёд.
    await api()
      .get(MessagesService)
      .dispatchDue(new Date(Date.now() + 10 * 60_000));
    await setState('started');
    await sendTo(client.token, phone, { text: 'Через бота' });
    await dispatch();

    const own = await api().inject({
      method: 'GET',
      url: '/client/messages/route-stats?days=7',
      headers: bearer(client.token),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({
      days: 7,
      recipients: 2,
      in_bot: 1,
      via_bot: 1,
      via_accounts: 2,
    });

    const report = await api().inject({
      method: 'GET',
      url: '/messages/report?days=7',
      headers: bearer(adminToken),
    });
    const routes = report.json<{ routes: { client_id: string; in_bot: number }[] }>().routes;
    expect(routes.find((row) => row.client_id === client.clientId)?.in_bot).toBe(1);
  });

  it('«где»: блок «только аккаунты» в сообщение бота не попадает, «только бот» — попадает; неверное значение отвергается', async () => {
    await connectPlatform();
    const { client, phone } = await subscribed(557, 79, '79001234569', 'Пётр');
    expect(
      (
        await putTemplate(client.token, [
          { kind: 'body', when: 'always' },
          { kind: 'text', text: 'только в боте', when: 'always', via: 'bot' },
          { kind: 'text', text: 'только через аккаунты', when: 'always', via: 'account' },
        ])
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await putTemplate(client.token, [
          { kind: 'body', when: 'always' },
          { kind: 'text', text: 'а', when: 'always', via: 'почта' },
        ])
      ).statusCode,
    ).toBe(400);
    expect(
      (await putTemplate(client.token, [{ kind: 'body', when: 'always', via: 'bot' }])).statusCode,
    ).toBe(400);

    await sendTo(client.token, phone);
    await api().get(MessagesService).dispatchDue(new Date());
    const sent = simulatedBotSent.at(-1)?.text ?? '';
    expect(sent).toContain('только в боте');
    expect(sent).not.toContain('только через аккаунты');
  });

  it('«Пустая строка», многострочный текст и {название}: уходят как собраны; GET отдаёт название компании', async () => {
    await connectPlatform();
    const { client, phone } = await subscribed(558, 80, '79001234570', 'Ольга');
    const saved = await putTemplate(client.token, [
      { kind: 'greeting', text: 'Добро пожаловать в {название}, {имя}!', when: 'always' },
      { kind: 'break', when: 'always' },
      { kind: 'body', when: 'always' },
      { kind: 'break', when: 'always' },
      { kind: 'text', text: 'Адрес: ул. Мира, 1\nТел. 000', when: 'always' },
    ]);
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ company: string }>().company).not.toBe('');
    // У «Пустой строки» текста нет.
    expect(
      (
        await putTemplate(client.token, [
          { kind: 'break', text: 'а', when: 'always' },
          { kind: 'body', when: 'always' },
        ])
      ).statusCode,
    ).toBe(400);

    await sendTo(client.token, phone);
    await api().get(MessagesService).dispatchDue(new Date());
    const sent = simulatedBotSent.at(-1)?.text ?? '';
    expect(sent).toMatch(
      /^Добро пожаловать в .+, Ольга!\n\nМашина подана\n\nАдрес: ул. Мира, 1\nТел. 000$/u,
    );
  });

  it('своё приветствие подставляет название службы; без него — стандартный текст', async () => {
    await connectPlatform();
    const client = await fx.clientWithMoney('5');
    const view = await api().inject({
      method: 'POST',
      url: '/client/messages/bot',
      headers: bearer(client.token),
    });
    const link = view.json<{ connection: { link: string } }>().connection.link;
    const botId = await botIdOf();
    await settingsPatch(client.token, { greeting: 'Добро пожаловать в {служба}!' });

    await event(botId, {
      update_type: 'bot_started',
      chat_id: 501,
      user: { user_id: 91 },
      payload: link.split('start=')[1],
    });
    // Свой текст клиента, а после него через пустую строку — призыв площадки нажать кнопку.
    expect(simulatedBotSent.at(-1)?.text).toMatch(
      /^Добро пожаловать в Такси .+!\n\nНажмите кнопку ниже 👇, чтобы получать уведомления\.$/u,
    );
    expect(simulatedBotSent.at(-1)?.requestContact).toBe('📲 Получать уведомления');

    await settingsPatch(client.token, { greeting: null });
    await event(botId, {
      update_type: 'bot_started',
      chat_id: 502,
      user: { user_id: 92 },
      payload: link.split('start=')[1],
    });
    expect(simulatedBotSent.at(-1)?.text).toContain('будет присылать вам уведомления');

    // Надпись кнопки — настройка площадки: длиннее 30 знаков не принимается, своя уходит в MAX.
    expect((await fx.put(adminToken, { 'bot.share_button': 'х'.repeat(31) })).statusCode).toBe(400);
    expect((await fx.put(adminToken, { 'bot.share_button': '✅ Подписаться' })).statusCode).toBe(
      200,
    );
    await event(botId, {
      update_type: 'bot_started',
      chat_id: 503,
      user: { user_id: 93 },
      payload: link.split('start=')[1],
    });
    expect(simulatedBotSent.at(-1)?.requestContact).toBe('✅ Подписаться');
    expect(simulatedBotSent.at(-1)?.text).toContain('Нажмите кнопку ниже 👇');
    expect((await fx.put(adminToken, { 'bot.share_button': '' })).statusCode).toBe(200);
  });

  it('запасной путь выключен: номер без подписчика не принимается и деньги не списываются; включён или бот не работает — идёт через аккаунты', async () => {
    await connectPlatform();
    const { client, phone } = await subscribed();
    await fx.partnerWithAccount('0.45');
    const stranger = '79005550123';

    // По умолчанию запасной путь есть.
    expect((await sendTo(client.token, stranger)).statusCode).toBe(201);
    expect(await fx.balance(client.token)).toBe('9.46');

    await settingsPatch(client.token, { fallbackAccounts: false });
    const refused = await sendTo(client.token, stranger);
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('не подписан');
    expect(await fx.balance(client.token)).toBe('9.46');

    // Подписчику бот пишет по-прежнему.
    expect((await sendTo(client.token, phone)).statusCode).toBe(201);

    // Бот клиента выключен — запрет не действует: сообщения должны доходить.
    await api().inject({
      method: 'PATCH',
      url: '/client/messages/bot',
      headers: bearer(client.token),
      payload: { enabled: false },
    });
    expect((await sendTo(client.token, stranger)).statusCode).toBe(201);
  });
});
