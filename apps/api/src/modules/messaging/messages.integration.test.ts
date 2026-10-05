/**
 * Сообщения MAX на реальной базе, провайдер — имитация (ADR-0071): приём с деньгами, очередь, паузы
 * и лимиты, возврат, статусы доставки, приватность.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  withDatabase,
} from '../../testing/harness.js';
import { bearer, fixtures } from './messaging.fixtures.js';
import { MessagesService } from './messages.service.js';
import { MessagingService } from './messaging.service.js';
import { simulateAccountState, simulatedSent } from './simulated.provider.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const MINUTE = 60_000;

const fx = fixtures(api, () => adminToken);
const { user, put, partnerWithAccount, clientWithMoney, balance } = fx;

const send = (token: string, payload: Record<string, unknown>) =>
  api().inject({ method: 'POST', url: '/client/messages', headers: bearer(token), payload });

interface MessageView {
  id: string;
  to: string;
  text: string;
  status: string;
  failure_reason: string | null;
  cost: string | null;
}

const owed = async (partnerId: string): Promise<string> =>
  (
    await api().inject({
      method: 'GET',
      url: `/partners/${partnerId}`,
      headers: bearer(adminToken),
    })
  ).json<{ partner: { balance: string } }>().partner.balance;

const messageOf = async (token: string, id: string): Promise<MessageView | undefined> =>
  (await api().inject({ method: 'GET', url: '/client/messages?limit=200', headers: bearer(token) }))
    .json<{ messages: MessageView[] }>()
    .messages.find((row) => row.id === id);

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  adminToken = (await user('admin')).token;
  expect((await put(adminToken, { 'messaging.enabled': true })).statusCode).toBe(200);
  // Паузу снимаем: сама пауза проверяется отдельным сценарием.
  expect((await put(adminToken, { 'messages.pace_seconds': 0 })).statusCode).toBe(200);
});

/**
 * Каждая проверка начинается без чужих аккаунтов и сообщений: рабочие аккаунты прошлых проверок
 * перехватывали бы выбор по цене и очередь отправки.
 */
beforeEach(async () => {
  await withDatabase(async (execute) => {
    await execute(sql`delete from messages`);
    await execute(sql`delete from messenger_accounts`);
  });
});

afterAll(async () => {
  await app?.close();
});

describe('приём сообщения и деньги', () => {
  it('цена партнёра 0,45 + наценка 20 % = 0,54 клиенту: клиент платит, партнёр зарабатывает, площадка удерживает', async () => {
    const partner = await partnerWithAccount('0.45');
    const client = await clientWithMoney('100');

    const response = await send(client.token, {
      to: '+7 900 123-45-67',
      text: 'Код подтверждения 1234',
    });
    expect(response.statusCode).toBe(201);
    const message = response.json<{ message: MessageView }>().message;
    expect(message).toMatchObject({ to: '79001234567', status: 'queued', cost: '0.54' });

    expect(await balance(client.token)).toBe('99.46');
    expect(await owed(partner.partnerId)).toBe('0.45');
  });

  it('повтор с тем же ключом возвращает прежнее и не списывает дважды; другое сообщение под тем же ключом — отказ', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const payload = { to: '79001234567', text: 'Привет', externalId: 'order-17' };

    const first = (await send(client.token, payload)).json<{ message: MessageView }>().message;
    const again = await send(client.token, payload);
    expect(again.json<{ message: MessageView }>().message.id).toBe(first.id);
    expect(await balance(client.token)).toBe('9.46');

    expect((await send(client.token, { ...payload, text: 'Совсем другое' })).statusCode).toBe(409);
    expect(await balance(client.token)).toBe('9.46');
  });

  it('денег не хватает — отказ, сообщения нет, баланс не тронут', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('0.5');
    const response = await send(client.token, { to: '79001234567', text: 'Привет' });
    expect(response.statusCode).toBe(409);

    const listed = await api().inject({
      method: 'GET',
      url: '/client/messages',
      headers: bearer(client.token),
    });
    expect(listed.json<{ total: number }>().total).toBe(0);
    expect(await balance(client.token)).toBe('0.5');
  });

  it('негодные номер и текст отвергаются, пока продукт выключен — 409, нет аккаунтов — 503', async () => {
    const client = await clientWithMoney('10');
    expect((await send(client.token, { to: '12345', text: 'x' })).statusCode).toBe(400);
    expect((await send(client.token, { to: '79001234567', text: '   ' })).statusCode).toBe(400);
    expect(
      (await send(client.token, { to: '79001234567', text: 'я'.repeat(4001) })).statusCode,
    ).toBe(400);

    // Рабочего аккаунта с ценой нет вовсе: принять некуда.
    expect((await send(client.token, { to: '79001234567', text: 'Привет' })).statusCode).toBe(503);

    await put(adminToken, { 'messaging.enabled': false });
    expect((await send(client.token, { to: '79001234567', text: 'Привет' })).statusCode).toBe(409);
    await put(adminToken, { 'messaging.enabled': true });
  });

  it('цена за сообщение клиенту видна сейчас, цена партнёра и наценка — нет', async () => {
    await partnerWithAccount('0.30');
    const client = await clientWithMoney('1');
    const price = await api().inject({
      method: 'GET',
      url: '/client/messages/price',
      headers: bearer(client.token),
    });
    expect(price.json()).toEqual({ enabled: true, price: '0.36' });
  });
});

describe('отправка воркером', () => {
  it('сообщение уходит через аккаунт партнёра с нужным получателем и текстом, статус — «ушло»', async () => {
    const partner = await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const id = (await send(client.token, { to: '79005550011', text: 'Ваш заказ принят' })).json<{
      message: MessageView;
    }>().message.id;

    expect(await api().get(MessagesService).dispatchDue(new Date())).toBeGreaterThanOrEqual(1);

    expect(await messageOf(client.token, id)).toMatchObject({ status: 'sent' });
    expect(simulatedSent.find((item) => item.recipient === '79005550011')).toMatchObject({
      instanceId: partner.instance,
      text: 'Ваш заказ принят',
    });
  });

  it('пауза аккаунта: второе сообщение ждёт, потом уходит', async () => {
    await put(adminToken, { 'messages.pace_seconds': 30 });
    try {
      await partnerWithAccount('0.45');
      const client = await clientWithMoney('10');
      const a = (await send(client.token, { to: '79005550021', text: 'Первое' })).json<{
        message: MessageView;
      }>().message.id;
      const b = (await send(client.token, { to: '79005550022', text: 'Второе' })).json<{
        message: MessageView;
      }>().message.id;
      const service = api().get(MessagesService);

      const now = new Date();
      await service.dispatchDue(now);
      const states = [
        (await messageOf(client.token, a))?.status,
        (await messageOf(client.token, b))?.status,
      ];
      expect(states.filter((state) => state === 'sent')).toHaveLength(1);
      expect(states.filter((state) => state === 'queued')).toHaveLength(1);

      await service.dispatchDue(new Date(now.getTime() + 2 * MINUTE));
      expect((await messageOf(client.token, a))?.status).toBe('sent');
      expect((await messageOf(client.token, b))?.status).toBe('sent');
    } finally {
      await put(adminToken, { 'messages.pace_seconds': 0 });
    }
  });

  it('лимит в минуту: сверх лимита сообщение ждёт в очереди, а не отклоняется', async () => {
    await partnerWithAccount('0.45', { limitPerMinute: 1 });
    const client = await clientWithMoney('10');
    const a = (await send(client.token, { to: '79005550031', text: 'А' })).json<{
      message: MessageView;
    }>().message.id;
    const b = (await send(client.token, { to: '79005550032', text: 'Б' })).json<{
      message: MessageView;
    }>().message.id;
    const service = api().get(MessagesService);

    const now = new Date();
    await service.dispatchDue(now);
    await service.dispatchDue(new Date(now.getTime() + 1000));
    const first = await messageOf(client.token, a);
    const second = await messageOf(client.token, b);
    expect([first?.status, second?.status].sort()).toEqual(['queued', 'sent']);

    await service.dispatchDue(new Date(now.getTime() + 2 * MINUTE));
    expect((await messageOf(client.token, b))?.status).toBe('sent');
  });
});

describe('не ушло — деньги возвращаются', () => {
  it('у номера нет MAX: сообщение отклонено с нашей причиной, клиенту вернули всё, партнёру ничего не причитается', async () => {
    const partner = await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const id = (await send(client.token, { to: '79005550000', text: 'Привет' })).json<{
      message: MessageView;
    }>().message.id;
    expect(await balance(client.token)).toBe('9.46');

    await api().get(MessagesService).dispatchDue(new Date());

    expect(await messageOf(client.token, id)).toMatchObject({
      status: 'failed',
      failure_reason: 'recipient_not_in_max',
      cost: null,
    });
    expect(await balance(client.token)).toBe('10');
    expect(await owed(partner.partnerId)).toBe('0');
  });

  it('временный сбой: повторы с паузами, после пяти — отказ и возврат', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const id = (await send(client.token, { to: '79005559999', text: 'Привет' })).json<{
      message: MessageView;
    }>().message.id;
    const service = api().get(MessagesService);

    let at = Date.now();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      at += 20 * MINUTE;
      await service.dispatchDue(new Date(at));
      const state = await messageOf(client.token, id);
      expect(state?.status).toBe(attempt < 5 ? 'queued' : 'failed');
    }
    expect(await messageOf(client.token, id)).toMatchObject({
      failure_reason: 'platform',
      cost: null,
    });
    expect(await balance(client.token)).toBe('10');
  });

  it('аккаунт вышел из MAX и не вернулся: по истечении срока ожидания — отказ и возврат', async () => {
    const partner = await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const id = (await send(client.token, { to: '79005550041', text: 'Привет' })).json<{
      message: MessageView;
    }>().message.id;

    simulateAccountState(partner.instance, 'not_authorized');
    await api()
      .get(MessagingService)
      .refreshDue(new Date(Date.now() + 10 * MINUTE));
    const service = api().get(MessagesService);
    await service.dispatchDue(new Date(Date.now() + 11 * MINUTE));
    expect((await messageOf(client.token, id))?.status).toBe('queued');

    expect(await service.expireWaiting(new Date(Date.now() + 60 * MINUTE))).toBeGreaterThanOrEqual(
      1,
    );
    expect(await messageOf(client.token, id)).toMatchObject({
      status: 'failed',
      failure_reason: 'wait_expired',
    });
    expect(await balance(client.token)).toBe('10');
  });
});

describe('статусы доставки от провайдера', () => {
  async function sentMessage() {
    const partner = await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const id = (await send(client.token, { to: '79005550051', text: 'Привет' })).json<{
      message: MessageView;
    }>().message.id;
    await api().get(MessagesService).dispatchDue(new Date());
    const providerId = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select provider_message_id as id from messages where id = ${id}`,
      );
      return (result.rows[0] as { id: string }).id;
    });
    return { partner, client, id, providerId };
  }

  const hook = (secret: string, payload: Record<string, unknown>) =>
    api().inject({ method: 'POST', url: `/webhooks/messenger/${secret}`, payload });

  it('доставлено → прочитано идёт только вперёд; чужой адрес закрыт', async () => {
    const { partner, client, id, providerId } = await sentMessage();
    const secret = api().get(MessagingService).webhookSecret();
    const status = (value: string) => ({
      typeWebhook: 'outgoingMessageStatus',
      idMessage: providerId,
      status: value,
      instanceData: { idInstance: partner.instance },
    });

    expect((await hook(secret, status('delivered'))).statusCode).toBe(200);
    expect((await messageOf(client.token, id))?.status).toBe('delivered');
    expect((await hook(secret, status('read'))).statusCode).toBe(200);
    expect((await messageOf(client.token, id))?.status).toBe('read');
    // Запоздавший «доставлено» не откатывает «прочитано».
    await hook(secret, status('delivered'));
    expect((await messageOf(client.token, id))?.status).toBe('read');

    expect((await hook('0'.repeat(32), status('delivered'))).statusCode).toBe(403);
    // Чужое для нас уведомление — молча принимается.
    expect((await hook(secret, { typeWebhook: 'incomingMessageReceived' })).statusCode).toBe(200);
  });

  it('провайдер сообщил, что у получателя нет аккаунта, уже после отправки — отказ и возврат', async () => {
    const { partner, client, id, providerId } = await sentMessage();
    await hook(api().get(MessagingService).webhookSecret(), {
      typeWebhook: 'outgoingMessageStatus',
      idMessage: providerId,
      status: 'noAccount',
      instanceData: { idInstance: partner.instance },
    });
    expect(await messageOf(client.token, id)).toMatchObject({
      status: 'failed',
      failure_reason: 'recipient_not_in_max',
    });
    expect(await balance(client.token)).toBe('10');
  });
});

describe('кто что видит', () => {
  it('клиент видит только свои сообщения без партнёра и аккаунта; сотрудник — деньги по трём счетам', async () => {
    const partner = await partnerWithAccount('0.45');
    const mine = await clientWithMoney('10');
    const other = await clientWithMoney('10');
    const id = (await send(mine.token, { to: '79005550061', text: 'Привет' })).json<{
      message: MessageView;
    }>().message.id;

    const own = await api().inject({
      method: 'GET',
      url: '/client/messages',
      headers: bearer(mine.token),
    });
    expect(own.body).not.toMatch(/partner|account|margin|provider|instance|green/iu);
    expect(
      (
        await api().inject({ method: 'GET', url: '/client/messages', headers: bearer(other.token) })
      ).json<{ total: number }>().total,
    ).toBe(0);

    const staff = (
      await api().inject({ method: 'GET', url: '/messages?limit=200', headers: bearer(adminToken) })
    ).json<{ messages: { id: string; partner_id: string; money: Record<string, string> }[] }>();
    const row = staff.messages.find((item) => item.id === id);
    expect(row).toMatchObject({
      partner_id: partner.partnerId,
      money: { client: '0.54', partner: '0.45', margin: '0.09' },
    });

    // Партнёру сотрудничий журнал закрыт.
    expect(
      (await api().inject({ method: 'GET', url: '/messages', headers: bearer(partner.ownerToken) }))
        .statusCode,
    ).toBe(403);
  });

  it('отправка по ключу API: /v1/messages', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const issued = await api().inject({
      method: 'POST',
      url: '/client/api-keys',
      headers: bearer(client.token),
      payload: { label: 'Система', allowedIps: [] },
    });
    const key = issued.json<{ key: { key_id: string; secret: string } }>().key;
    const machine = { authorization: `Bearer ${key.key_id}.${key.secret}` };

    const sent = await api().inject({
      method: 'POST',
      url: '/v1/messages',
      headers: machine,
      payload: { to: '79005550071', text: 'Из системы клиента', externalId: 'sys-1' },
    });
    expect(sent.statusCode).toBe(201);
    const id = sent.json<{ message: MessageView }>().message.id;

    const one = await api().inject({ method: 'GET', url: `/v1/messages/${id}`, headers: machine });
    expect(one.json<{ message: MessageView }>().message).toMatchObject({
      status: 'queued',
      cost: '0.54',
    });
    expect(
      (await api().inject({ method: 'GET', url: '/v1/messages', headers: machine })).json<{
        total: number;
      }>().total,
    ).toBe(1);
  });
});

describe('акт клиента за месяц', () => {
  it('сообщения идут отдельными итогами — списано и возвращено, остаток сходится', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    await send(client.token, { to: '79005550091', text: 'Дойдёт' });
    await send(client.token, { to: '79005550000', text: 'Не дойдёт' });
    await api().get(MessagesService).dispatchDue(new Date());

    const month = new Date().toISOString().slice(0, 7);
    const statement = (
      await api().inject({
        method: 'GET',
        url: `/client/statement?month=${month}&offset=0`,
        headers: bearer(client.token),
      })
    ).json<{
      opening_balance: string;
      closing_balance: string;
      charged: string;
      message_charged: string;
      message_refunded: string;
      movements: { amount: string }[];
    }>();

    expect(statement).toMatchObject({
      message_charged: '1.08',
      message_refunded: '0.54',
      charged: '0',
      closing_balance: '9.46',
    });
    // Сообщения не засоряют строки движения: пополнение — единственная строка.
    expect(statement.movements).toHaveLength(1);
    const moved = statement.movements.reduce((sum, row) => sum + Number(row.amount), 0);
    expect(
      Number(statement.opening_balance) +
        moved -
        Number(statement.charged) -
        Number(statement.message_charged) +
        Number(statement.message_refunded),
    ).toBeCloseTo(Number(statement.closing_balance), 6);
  });
});

describe('текст — персональные данные', () => {
  it('по истечении срока хранения текст стирается, строка с суммами остаётся', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const id = (await send(client.token, { to: '79005550081', text: 'Секретный текст' })).json<{
      message: MessageView;
    }>().message.id;

    const erased = await api()
      .get(MessagesService)
      .purgeTexts(new Date(Date.now() + 40 * 24 * 60 * MINUTE));
    expect(erased).toBeGreaterThanOrEqual(1);
    expect(await messageOf(client.token, id)).toMatchObject({ text: '', cost: '0.54' });
  });
});
