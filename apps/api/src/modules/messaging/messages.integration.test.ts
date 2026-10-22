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
import { RedisService } from '../../infra/redis.js';
import { simulateAccountState, simulatedChecks, simulatedSent } from './simulated.provider.js';

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
  stop_line: boolean;
  full_text: string | null;
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
  // «Рекомендованная работа» отключена нулями: её темп (20 с, 2 в минуту) тормозил бы тесты, которые шлют подряд (проверяется отдельно).
  expect(
    (
      await put(adminToken, {
        'messages.recommended_pace_seconds': 0,
        'messages.recommended_per_minute': 0,
        'messages.recommended_per_hour': 0,
        'messages.recommended_per_day': 0,
      })
    ).statusCode,
  ).toBe(200);
  // Тесты шлют много сообщений одному номеру: предел на номер отключён (проверяется отдельно).
  expect(
    (
      await put(adminToken, {
        'messages.recipient_limit_per_hour': 0,
        'messages.recipient_limit_per_day': 0,
      })
    ).statusCode,
  ).toBe(200);
});

/**
 * Каждая проверка начинается без чужих аккаунтов и сообщений: рабочие аккаунты прошлых проверок
 * перехватывали бы выбор по цене и очередь отправки.
 */
beforeEach(async () => {
  await withDatabase(async (execute) => {
    await execute(sql`delete from message_stops`);
    await execute(sql`delete from messages`);
    await execute(sql`delete from messenger_accounts`);
    // Правила наценки, заведённые проверками; общее правило из миграции (2000 год) остаётся.
    await execute(
      sql`delete from commission_rules where product = 'message' and effective_from > timestamptz '2001-01-01'`,
    );
  });
});

afterAll(async () => {
  await app?.close();
});

describe('защита от повторов (messages.duplicate_window_minutes)', () => {
  it('тот же текст тому же номеру за окно — отказ 409; другой текст и другой номер проходят', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const first = await send(client.token, { to: '79005550201', text: 'Здравствуйте!' });
    expect(first.statusCode).toBe(201);

    const again = await send(client.token, { to: '79005550201', text: 'Здравствуйте!' });
    expect(again.statusCode).toBe(409);
    expect(
      again.json<{ error: { details: Record<string, unknown> } }>().error.details,
    ).toMatchObject({
      reason: 'duplicate_message',
      window_minutes: 10,
    });

    expect(
      (await send(client.token, { to: '79005550201', text: 'Здравствуйте, Иван!' })).statusCode,
    ).toBe(201);
    expect(
      (await send(client.token, { to: '79005550202', text: 'Здравствуйте!' })).statusCode,
    ).toBe(201);
    // Отказ денег не списал: три принятых сообщения по 0,54, остальное на счёте.
    expect(await balance(client.token)).toBe('8.38');
  });

  it('повтор по тому же внешнему номеру — это тот же запрос, а не дубль', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const payload = { to: '79005550203', text: 'Код 4321', externalId: 'dup-1' };
    expect((await send(client.token, payload)).statusCode).toBe(201);
    expect((await send(client.token, payload)).statusCode).toBeLessThan(300);
  });

  it('окно 0 — проверка выключена', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    expect((await put(adminToken, { 'messages.duplicate_window_minutes': 0 })).statusCode).toBe(
      200,
    );
    try {
      expect((await send(client.token, { to: '79005550204', text: 'Повтор' })).statusCode).toBe(
        201,
      );
      expect((await send(client.token, { to: '79005550204', text: 'Повтор' })).statusCode).toBe(
        201,
      );
    } finally {
      await put(adminToken, { 'messages.duplicate_window_minutes': 10 });
    }
  });
});

describe('предел сообщений одному номеру', () => {
  it('сверх часового предела — 429 с пояснением, деньги не списываются; другой номер проходит', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    expect((await put(adminToken, { 'messages.recipient_limit_per_hour': 2 })).statusCode).toBe(
      200,
    );
    try {
      expect((await send(client.token, { to: '79005550301', text: 'Первое' })).statusCode).toBe(
        201,
      );
      expect((await send(client.token, { to: '79005550301', text: 'Второе' })).statusCode).toBe(
        201,
      );
      const before = await balance(client.token);
      const third = await send(client.token, { to: '79005550301', text: 'Третье' });
      expect(third.statusCode).toBe(429);
      expect(third.json<{ error: { details?: { reason?: string } } }>().error.details?.reason).toBe(
        'recipient_limit',
      );
      expect(await balance(client.token)).toBe(before);
      expect((await send(client.token, { to: '79005550302', text: 'Другому' })).statusCode).toBe(
        201,
      );
    } finally {
      await put(adminToken, { 'messages.recipient_limit_per_hour': 0 });
    }
  });

  it('суточный предел работает отдельно от часового; 0 — без предела', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    expect((await put(adminToken, { 'messages.recipient_limit_per_day': 1 })).statusCode).toBe(200);
    try {
      expect((await send(client.token, { to: '79005550303', text: 'Раз' })).statusCode).toBe(201);
      expect((await send(client.token, { to: '79005550303', text: 'Два' })).statusCode).toBe(429);
    } finally {
      await put(adminToken, { 'messages.recipient_limit_per_day': 0 });
    }
    expect((await send(client.token, { to: '79005550303', text: 'Три' })).statusCode).toBe(201);
  });
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

  it('публичное «от»: самая низкая цена для клиента с общей наценкой, без партнёра (ADR-0082)', async () => {
    await partnerWithAccount('0.45');
    const { PublicPricesController } = await import('../site/public-prices.controller.js');
    api().get(PublicPricesController).resetCache();

    const response = await api().inject({ method: 'GET', url: '/public/prices' });
    expect(response.statusCode).toBe(200);
    // 0,45 + 20 % общей наценки.
    expect(response.json<{ message_from: string | null }>().message_from).toBe('0.54');
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      'call_from',
      'message_from',
      'updated_at',
    ]);
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
    // По умолчанию у аккаунта включена строка про «СТОП» (ADR-0092): она добавляется в конец.
    expect(simulatedSent.find((item) => item.recipient === '79005550011')).toMatchObject({
      instanceId: partner.instance,
      text: 'Ваш заказ принят\n\nЧтобы отписаться, ответьте СТОП',
    });
    expect(await messageOf(client.token, id)).toMatchObject({ stop_line: true });
    // Полный текст — как получил человек (ADR-0093); сотруднику ни текст, ни полный текст не отдаются.
    expect((await messageOf(client.token, id))?.full_text).toBe(
      'Ваш заказ принят\n\nЧтобы отписаться, ответьте СТОП',
    );
    const staff = (
      await api().inject({ method: 'GET', url: '/messages?limit=50', headers: bearer(adminToken) })
    ).json<{ messages: Record<string, unknown>[] }>().messages;
    expect(staff.length).toBeGreaterThan(0);
    expect(staff[0]).not.toHaveProperty('text');
    expect(staff[0]).not.toHaveProperty('full_text');
  });

  it('партнёр выключает «СТОП» у аккаунта: текст уходит как написан, клиент видит, что строки не было; чужой аккаунт не тронуть', async () => {
    const partner = await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const accountId = await withDatabase(async (execute) => {
      const result = await execute(sql`select id from messenger_accounts limit 1`);
      return (result.rows[0] as { id: string }).id;
    });
    const patch = (token: string, body: Record<string, unknown>) =>
      api().inject({
        method: 'PATCH',
        url: `/partner/messenger/accounts/${accountId}`,
        headers: bearer(token),
        payload: body,
      });

    expect((await patch(partner.ownerToken, {})).statusCode).toBe(400);
    expect((await patch(client.token, { stopLine: false })).statusCode).toBe(403);
    const off = await patch(partner.ownerToken, { stopLine: false });
    expect(off.statusCode).toBe(200);
    expect(off.json<{ account: { stop_line: boolean } }>().account.stop_line).toBe(false);

    const id = (await send(client.token, { to: '79005550081', text: 'Без строки' })).json<{
      message: MessageView;
    }>().message.id;
    await api().get(MessagesService).dispatchDue(new Date());
    expect(simulatedSent.find((item) => item.recipient === '79005550081')?.text).toBe('Без строки');
    expect(await messageOf(client.token, id)).toMatchObject({ stop_line: false });
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

describe('автопрогрев и равномерная отправка (ADR-0078)', () => {
  const accountView = async (id: string) =>
    (await api().inject({ method: 'GET', url: '/messenger/accounts', headers: bearer(adminToken) }))
      .json<{
        accounts: {
          id: string;
          warmup_enabled: boolean;
          warmup_day: number | null;
          daily_limit_now: number | null;
        }[];
      }>()
      .accounts.find((account) => account.id === id);

  it('новый аккаунт в первые сутки отправляет по одному сообщению в час: остальное ждёт, не отклоняется', async () => {
    const partner = await partnerWithAccount('0.45', {}, true);
    const client = await clientWithMoney('10');
    const a = (await send(client.token, { to: '79005550041', text: 'А' })).json<{
      message: MessageView;
    }>().message.id;
    const b = (await send(client.token, { to: '79005550042', text: 'Б' })).json<{
      message: MessageView;
    }>().message.id;
    const service = api().get(MessagesService);

    expect(await accountView(partner.accountId)).toMatchObject({
      warmup_enabled: true,
      warmup_day: 0,
      daily_limit_now: 12,
    });
    const now = new Date();
    await service.dispatchDue(now);
    await service.dispatchDue(new Date(now.getTime() + 5 * MINUTE));
    const states = [
      (await messageOf(client.token, a))?.status,
      (await messageOf(client.token, b))?.status,
    ];
    expect(states.sort()).toEqual(['queued', 'sent']);

    await service.dispatchDue(new Date(now.getTime() + 61 * MINUTE));
    expect((await messageOf(client.token, a))?.status).toBe('sent');
    expect((await messageOf(client.token, b))?.status).toBe('sent');
  });

  it('молчал дольше 14 суток — после отправки прогрев начинается заново; работающий не сбрасывается', async () => {
    const quiet = await partnerWithAccount('0.45', {}, true);
    const client = await clientWithMoney('10');
    await withDatabase(async (execute) => {
      await execute(
        sql`update messenger_accounts set warmup_started_at = now() - interval '40 days', last_used_at = now() - interval '20 days' where id = ${quiet.accountId}`,
      );
    });
    await send(client.token, { to: '79005550101', text: 'После долгого молчания' });
    await api().get(MessagesService).dispatchDue(new Date());
    const restarted = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select warmup_started_at > now() - interval '5 minutes' as fresh from messenger_accounts where id = ${quiet.accountId}`,
      );
      return (result.rows[0] as { fresh: boolean }).fresh;
    });
    expect(restarted).toBe(true);
  });

  it('работающий аккаунт прогрев не теряет: последняя отправка двое суток назад', async () => {
    const busy = await partnerWithAccount('0.45', {}, true);
    const client = await clientWithMoney('10');
    await withDatabase(async (execute) => {
      await execute(
        sql`update messenger_accounts set warmup_started_at = now() - interval '40 days', last_used_at = now() - interval '2 days' where id = ${busy.accountId}`,
      );
    });
    await send(client.token, { to: '79005550102', text: 'Обычная работа' });
    await api().get(MessagesService).dispatchDue(new Date());
    const kept = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select warmup_started_at < now() - interval '30 days' as old from messenger_accounts where id = ${busy.accountId}`,
      );
      return (result.rows[0] as { old: boolean }).old;
    });
    expect(kept).toBe(true);
  });

  it('суточный предел прогрева: после 12 сообщений за сутки следующее ждёт, даже если часовая доля свободна', async () => {
    const partner = await partnerWithAccount('0.45', {}, true);
    // Прогрев закончился давно: потолок 500 в сутки, 42 в час. Ставим предел суток 3 тарифом.
    await withDatabase(async (execute) => {
      await execute(
        sql`update messenger_accounts set warmup_started_at = now() - interval '40 days', last_used_at = now(), limit_per_day = 3 where id = ${partner.accountId}`,
      );
    });
    const client = await clientWithMoney('10');
    const ids: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      ids.push(
        (await send(client.token, { to: `7900555005${String(n)}`, text: 'Т' })).json<{
          message: MessageView;
        }>().message.id,
      );
    }
    const service = api().get(MessagesService);
    const now = new Date();
    // Часовая доля при 3 в сутки — одно сообщение: каждый час уходит по одному, на четвёртое суточный предел.
    for (let hour = 0; hour < 4; hour += 1) {
      await service.dispatchDue(new Date(now.getTime() + (hour * 61 + 1) * MINUTE));
    }
    const statuses = await Promise.all(
      ids.map(async (id) => (await messageOf(client.token, id))?.status),
    );
    expect(statuses.filter((status) => status === 'sent')).toHaveLength(3);
    expect(statuses.filter((status) => status === 'queued')).toHaveLength(1);
  });

  it('выключенный прогрев оставляет только лимиты тарифа; решение администратора пишется в журнал', async () => {
    const partner = await partnerWithAccount('0.45', {}, true);
    const off = await api().inject({
      method: 'PATCH',
      url: `/messenger/accounts/${partner.accountId}/warmup`,
      headers: bearer(adminToken),
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(await accountView(partner.accountId)).toMatchObject({
      warmup_enabled: false,
      warmup_day: null,
      daily_limit_now: null,
    });
    const audit = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select count(*)::int as n from audit_log where action = 'messenger_account.warmup_changed' and entity_id = ${partner.accountId}`,
      );
      return (result.rows[0] as { n: number }).n;
    });
    expect(audit).toBe(1);

    // Партнёру и поддержке менять нельзя.
    const forbidden = await api().inject({
      method: 'PATCH',
      url: `/messenger/accounts/${partner.accountId}/warmup`,
      headers: bearer(partner.ownerToken),
      payload: { enabled: true },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('аккаунт получил ограничение от MAX: прогрев начинается заново', async () => {
    const partner = await partnerWithAccount('0.45', {}, true);
    await withDatabase(async (execute) => {
      await execute(
        sql`update messenger_accounts set warmup_started_at = now() - interval '10 days' where id = ${partner.accountId}`,
      );
    });
    expect((await accountView(partner.accountId))?.warmup_day).toBe(10);

    const messaging = api().get(MessagingService);
    simulateAccountState(partner.instance, 'suspended', '79990001122');
    await messaging.refreshDue(new Date(Date.now() + 2 * MINUTE));
    simulateAccountState(partner.instance, 'authorized', '79990001122');
    await messaging.refreshDue(new Date(Date.now() + 4 * MINUTE));
    expect((await accountView(partner.accountId))?.warmup_day).toBe(0);
  });
});

describe('распределение и здоровье аккаунтов (ADR-0079)', () => {
  /** Ещё один рабочий аккаунт того же партнёра: идёт за его тарифом по умолчанию, прогрев выключен. */
  async function addAccount(partner: { ownerToken: string }) {
    const made = await api().inject({
      method: 'POST',
      url: '/partner/messenger/accounts',
      headers: bearer(partner.ownerToken),
      payload: { label: 'Дополнительный' },
    });
    expect(made.statusCode).toBe(201);
    const accountId = made.json<{ account: { id: string } }>().account.id;
    const instance = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select provider_instance_id as instance from messenger_accounts where id = ${accountId}`,
      );
      return (result.rows[0] as { instance: string }).instance;
    });
    await withDatabase(async (execute) => {
      await execute(
        sql`update messenger_accounts set warmup_enabled = false where id = ${accountId}`,
      );
    });
    simulateAccountState(instance, 'authorized', '79990003344');
    await api().inject({
      method: 'GET',
      url: `/partner/messenger/accounts/${accountId}/qr`,
      headers: bearer(partner.ownerToken),
    });
    return { accountId, instance };
  }

  const accountsOf = async (ids: string[]) =>
    withDatabase(async (execute) => {
      const result = await execute(
        sql`select account_id as id, count(*)::int as n from messages where id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) group by account_id order by n desc`,
      );
      return result.rows as { id: string; n: number }[];
    });

  it('поток делится поровну между равными аккаунтами партнёра', async () => {
    await put(adminToken, { 'messages.pace_seconds': 0 });
    const partner = await partnerWithAccount('0.45');
    await addAccount(partner);
    await addAccount(partner);
    const client = await clientWithMoney('10');
    const ids: string[] = [];
    for (let n = 0; n < 6; n += 1) {
      ids.push(
        (await send(client.token, { to: `7900555006${String(n)}`, text: 'Р' })).json<{
          message: MessageView;
        }>().message.id,
      );
    }
    expect((await accountsOf(ids)).map((row) => row.n)).toEqual([2, 2, 2]);
  });

  it('аккаунт упёрся в лимит, а у соседа того же партнёра есть запас: сообщение переносится и уходит', async () => {
    await put(adminToken, { 'messages.pace_seconds': 0 });
    const partner = await partnerWithAccount('0.45', { limitPerMinute: 1 });
    const client = await clientWithMoney('10');
    const first = (await send(client.token, { to: '79005550071', text: 'А' })).json<{
      message: MessageView;
    }>().message.id;
    const second = (await send(client.token, { to: '79005550072', text: 'Б' })).json<{
      message: MessageView;
    }>().message.id;
    // Оба встали на единственный аккаунт; сосед появился позже.
    expect((await accountsOf([first, second])).map((row) => row.n)).toEqual([2]);
    const neighbour = await addAccount(partner);

    await api().get(MessagesService).dispatchDue(new Date());
    expect((await messageOf(client.token, first))?.status).toBe('sent');
    expect((await messageOf(client.token, second))?.status).toBe('sent');
    expect(simulatedSent.find((item) => item.recipient === '79005550072')?.instanceId).toBe(
      neighbour.instance,
    );
    expect((await accountsOf([first, second])).map((row) => row.n)).toEqual([1, 1]);
  });

  it('много «нет MAX» после отправки: аккаунт встаёт на паузу, но последний рабочий не трогается', async () => {
    await put(adminToken, {
      'messages.pace_seconds': 0,
      'messages.health_min_sample': 5,
      'messages.health_max_absent_percent': 30,
    });
    const partner = await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const secret = api().get(MessagingService).webhookSecret();
    const ids: string[] = [];
    for (let n = 0; n < 6; n += 1) {
      ids.push(
        (await send(client.token, { to: `7900555008${String(n)}`, text: 'З' })).json<{
          message: MessageView;
        }>().message.id,
      );
    }
    await api().get(MessagesService).dispatchDue(new Date());
    for (const id of ids.slice(0, 4)) {
      const providerId = await withDatabase(async (execute) => {
        const result = await execute(
          sql`select provider_message_id as id from messages where id = ${id}`,
        );
        return (result.rows[0] as { id: string }).id;
      });
      await api().inject({
        method: 'POST',
        url: `/webhooks/messenger/${secret}`,
        payload: {
          typeWebhook: 'outgoingMessageStatus',
          idMessage: providerId,
          status: 'noAccount',
          instanceData: { idInstance: partner.instance },
        },
      });
    }

    const service = api().get(MessagesService);
    // Аккаунт единственный: пауза означала бы остановку всей отправки.
    expect(await service.checkHealth(new Date())).toBe(0);

    await addAccount(partner);
    expect(await service.checkHealth(new Date())).toBe(1);
    const view = (
      await api().inject({ method: 'GET', url: '/messenger/accounts', headers: bearer(adminToken) })
    )
      .json<{
        accounts: { id: string; paused_until: string | null; pause_reason: string | null }[];
      }>()
      .accounts.find((account) => account.id === partner.accountId);
    expect(view?.pause_reason).toBe('absent_rate');
    expect(view?.paused_until).not.toBeNull();
    // Повторно та же статистика не ставит паузу второй раз.
    expect(await service.checkHealth(new Date())).toBe(0);

    // Новое сообщение идёт мимо аккаунта на паузе.
    const next = (await send(client.token, { to: '79005550099', text: 'Н' })).json<{
      message: MessageView;
    }>().message.id;
    expect((await accountsOf([next]))[0]?.id).not.toBe(partner.accountId);

    // Администратор снимает паузу; партнёру менять нельзя.
    const denied = await api().inject({
      method: 'POST',
      url: `/messenger/accounts/${partner.accountId}/resume`,
      headers: bearer(partner.ownerToken),
    });
    expect(denied.statusCode).toBe(403);
    const resumed = await api().inject({
      method: 'POST',
      url: `/messenger/accounts/${partner.accountId}/resume`,
      headers: bearer(adminToken),
    });
    expect(
      resumed.json<{ account: { paused_until: string | null } }>().account.paused_until,
    ).toBeNull();
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

  describe('проверка наличия MAX до отправки', () => {
    const redisKey = (recipient: string) => `messaging:max:${recipient}`;
    const timesChecked = (recipient: string) =>
      simulatedChecks.filter((item) => item === recipient).length;

    it('номера без MAX отклоняются до отправки, повторная проверка берётся из памяти', async () => {
      await partnerWithAccount('0.45');
      const client = await clientWithMoney('10');
      const recipient = '79001110000';
      await api().get(RedisService).connection.del(redisKey(recipient));
      const sentBefore = simulatedSent.length;

      const first = (await send(client.token, { to: recipient, text: 'Привет' })).json<{
        message: MessageView;
      }>().message.id;
      const second = (await send(client.token, { to: recipient, text: 'Ещё' })).json<{
        message: MessageView;
      }>().message.id;
      await api().get(MessagesService).dispatchDue(new Date());

      for (const id of [first, second]) {
        expect(await messageOf(client.token, id)).toMatchObject({
          status: 'failed',
          failure_reason: 'recipient_not_in_max',
        });
      }
      expect(await balance(client.token)).toBe('10');
      expect(simulatedSent).toHaveLength(sentBefore);
      expect(timesChecked(recipient)).toBe(1);
    });

    it('предел проверок исчерпан — сообщение уходит, а аккаунт больше не спрашивается', async () => {
      await partnerWithAccount('0.45');
      const client = await clientWithMoney('10');
      const limited = '79003337777';
      const next = '79003338881';
      const redis = api().get(RedisService).connection;
      await redis.del(redisKey(limited), redisKey(next));
      for (const key of await redis.keys('messaging:max:pause:*')) await redis.del(key);

      await send(client.token, { to: limited, text: 'Раз' });
      await send(client.token, { to: next, text: 'Два' });
      await api().get(MessagesService).dispatchDue(new Date());

      expect(simulatedSent.some((item) => item.recipient === limited)).toBe(true);
      expect(simulatedSent.some((item) => item.recipient === next)).toBe(true);
      expect(timesChecked(limited)).toBe(1);
      expect(timesChecked(next)).toBe(0);
      for (const key of await redis.keys('messaging:max:pause:*')) await redis.del(key);
    });

    it('проверка не удалась — сообщение всё равно уходит; выключатель отключает проверку', async () => {
      await partnerWithAccount('0.45');
      const client = await clientWithMoney('10');
      const unknown = '79005558888';
      const service = api().get(MessagesService);
      await api().get(RedisService).connection.del(redisKey(unknown));

      const id = (await send(client.token, { to: unknown, text: 'Дойдёт' })).json<{
        message: MessageView;
      }>().message.id;
      await service.dispatchDue(new Date());
      expect((await messageOf(client.token, id))?.status).toBe('sent');
      expect(timesChecked(unknown)).toBe(1);

      await put(adminToken, { 'messages.precheck_enabled': false });
      const absent = '79002220000';
      await api().get(RedisService).connection.del(redisKey(absent));
      const rejected = (await send(client.token, { to: absent, text: 'Нет MAX' })).json<{
        message: MessageView;
      }>().message.id;
      await service.dispatchDue(new Date());
      // Без предпроверки отказ приходит по ответу отправки — итог тот же, но о номере не спрашивали.
      expect(await messageOf(client.token, rejected)).toMatchObject({
        failure_reason: 'recipient_not_in_max',
      });
      expect(timesChecked(absent)).toBe(0);
    });
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

describe('журнал аккаунтов: срок хранения (ADR-0088)', () => {
  it('старые проверки номеров и события стираются вместе с текстами; свежие остаются', async () => {
    await partnerWithAccount('0.45');
    await withDatabase(async (execute) => {
      const accountId = (
        (await execute(sql`select id from messenger_accounts limit 1`)).rows[0] as { id: string }
      ).id;
      await execute(sql`delete from number_checks`);
      await execute(sql`delete from messenger_account_events`);
      await execute(sql`insert into number_checks (id, account_id, result, created_at) values
        (gen_random_uuid(), ${accountId}::uuid, 'exists', now() - interval '60 days'),
        (gen_random_uuid(), ${accountId}::uuid, 'absent', now() - interval '1 day')`);
      await execute(sql`insert into messenger_account_events (id, account_id, kind, reason, created_at) values
        (gen_random_uuid(), ${accountId}::uuid, 'unavailable', 'blocked', now() - interval '400 days'),
        (gen_random_uuid(), ${accountId}::uuid, 'unavailable', 'blocked', now() - interval '10 days')`);
    });
    await api().get(MessagesService).purgeTexts(new Date());
    const left = await withDatabase(async (execute) => ({
      checks: (await execute(sql`select count(*)::int as n from number_checks`)).rows[0] as {
        n: number;
      },
      events: (await execute(sql`select count(*)::int as n from messenger_account_events`))
        .rows[0] as { n: number },
    }));
    expect(left.checks.n).toBe(1);
    expect(left.events.n).toBe(1);
  });
});

describe('рекомендованная работа (ADR-0088)', () => {
  const profile = (values: Record<string, number>) =>
    put(adminToken, {
      'messages.recommended_pace_seconds': values['pace'] ?? 0,
      'messages.recommended_per_minute': values['minute'] ?? 0,
      'messages.recommended_per_hour': values['hour'] ?? 0,
      'messages.recommended_per_day': values['day'] ?? 0,
    });

  afterAll(async () => {
    await profile({});
  });

  it('лимит профиля заменяет тариф: второе сообщение ждёт в очереди; выключенная галочка снимает ограничение; партнёр значений не видит', async () => {
    const partner = await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const accountId = await withDatabase(async (execute) => {
      const result = await execute(sql`select id from messenger_accounts limit 1`);
      return (result.rows[0] as { id: string }).id;
    });
    const patch = (body: Record<string, unknown>) =>
      api().inject({
        method: 'PATCH',
        url: `/partner/messenger/accounts/${accountId}`,
        headers: bearer(partner.ownerToken),
        payload: body,
      });
    await withDatabase(async (execute) => {
      await execute(sql`update messenger_accounts set warmup_enabled = false`);
    });

    expect((await profile({ minute: 1 })).statusCode).toBe(200);
    const status = async (id: string) => (await messageOf(client.token, id))?.status;
    const first = (await send(client.token, { to: '79005550101', text: 'раз' })).json<{
      message: MessageView;
    }>().message.id;
    const second = (await send(client.token, { to: '79005550102', text: 'два' })).json<{
      message: MessageView;
    }>().message.id;
    await api().get(MessagesService).dispatchDue(new Date());
    expect(await status(first)).toBe('sent');
    expect(await status(second)).toBe('queued');

    // Партнёр видит только галочку, но не цифры профиля.
    const view = await patch({ recommended: true });
    expect(view.statusCode).toBe(200);
    expect(view.json<{ account: Record<string, unknown> }>().account).toMatchObject({
      recommended: true,
      limit_per_minute: null,
    });

    // Галочку сняли — аккаунт работает по своему тарифу, без профиля.
    expect((await patch({ recommended: false })).statusCode).toBe(200);
    await api()
      .get(MessagesService)
      .dispatchDue(new Date(Date.now() + 2 * 60_000));
    expect(await status(second)).toBe('sent');
    expect((await patch({})).statusCode).toBe(400);
  });
});

describe('«СТОП» (ADR-0088)', () => {
  const stopFromInstance = (instance: string, phone: string) =>
    api().inject({
      method: 'POST',
      url: `/webhooks/messenger/${api().get(MessagingService).webhookSecret()}`,
      payload: {
        typeWebhook: 'incomingMessageReceived',
        instanceData: { idInstance: instance },
        senderData: { chatId: `${phone}@c.us` },
        messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'СТОП' } },
      },
    });

  it('«СТОП» после сообщения клиента останавливает только его; другой клиент пишет; список и снятие запрета', async () => {
    const partner = await partnerWithAccount('0.45');
    const first = await clientWithMoney('10');
    const second = await clientWithMoney('10');
    await send(first.token, { to: '79005550091', text: 'от первого' });
    await api().get(MessagesService).dispatchDue(new Date());

    expect((await stopFromInstance(partner.instance, '79005550091')).statusCode).toBe(200);

    const refused = await send(first.token, { to: '79005550091', text: 'ещё от первого' });
    expect(refused.statusCode).toBe(409);
    expect((await send(second.token, { to: '79005550091', text: 'от второго' })).statusCode).toBe(
      201,
    );

    const listed = await api().inject({
      method: 'GET',
      url: '/messages/stops?phone=79005550091',
      headers: bearer(adminToken),
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json<{
      total: number;
      stops: { id: string; phone: string; source: string; client_name: string | null }[];
    }>();
    expect(body.total).toBe(1);
    expect(body.stops[0]).toMatchObject({ phone: '+7 900 ***-**-91', source: 'account' });
    expect(body.stops[0]?.client_name).toMatch(/^Такси /u);
    expect(JSON.stringify(body)).not.toContain('79005550091');

    const none = await api().inject({
      method: 'GET',
      url: '/messages/stops?phone=abc',
      headers: bearer(adminToken),
    });
    expect(none.json<{ total: number }>().total).toBe(0);
    expect(
      (
        await api().inject({
          method: 'GET',
          url: '/messages/stops',
          headers: bearer(first.token),
        })
      ).statusCode,
    ).toBe(403);

    const id = body.stops[0]?.id ?? '';
    expect(
      (
        await api().inject({
          method: 'DELETE',
          url: `/messages/stops/${id}`,
          headers: bearer(first.token),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await api().inject({
          method: 'DELETE',
          url: `/messages/stops/${id}`,
          headers: bearer(adminToken),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await api().inject({
          method: 'DELETE',
          url: `/messages/stops/${id}`,
          headers: bearer(adminToken),
        })
      ).statusCode,
    ).toBe(404);
    expect((await send(first.token, { to: '79005550091', text: 'снова' })).statusCode).toBe(201);

    const audited = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select before from audit_log where action = 'message_stop.removed'`,
      );
      return JSON.stringify(result.rows);
    });
    expect(audited).toContain('+7 900 ***-**-91');
    expect(audited).not.toContain('79005550091');
  });

  const stopFrom = (secret: string, phone: string, text = 'СТОП') =>
    api().inject({
      method: 'POST',
      url: `/webhooks/messenger/${secret}`,
      payload: {
        typeWebhook: 'incomingMessageReceived',
        instanceData: { idInstance: 1 },
        senderData: { chatId: `${phone}@c.us` },
        messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
      },
    });

  it('«СТОП» без истории переписки закрывает номер для всех клиентов; обычный ответ не закрывает; чужой адрес закрыт', async () => {
    await partnerWithAccount('0.45');
    const first = await clientWithMoney('10');
    const second = await clientWithMoney('10');
    const secret = api().get(MessagingService).webhookSecret();

    expect((await stopFrom(secret, '79005550071', 'спасибо')).statusCode).toBe(200);
    expect((await send(first.token, { to: '79005550071', text: 'раз' })).statusCode).toBe(201);

    expect((await stopFrom(secret, '79005550071')).statusCode).toBe(200);
    expect((await stopFrom(secret, '79005550071')).statusCode).toBe(200);
    expect((await stopFrom('чужой-адрес', '79005550072')).statusCode).toBe(403);

    for (const client of [first, second]) {
      const refused = await send(client.token, { to: '79005550071', text: 'ещё' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
        'recipient_stopped',
      );
    }
    // Отказ до списания денег: у второго клиента остаток целый.
    expect(await balance(second.token)).toBe('10');
    expect((await send(second.token, { to: '79005550073', text: 'другому' })).statusCode).toBe(201);
  });

  it('«СТОП» пришёл после приёма: сообщение не уходит, деньги возвращаются', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const secret = api().get(MessagingService).webhookSecret();
    const accepted = await send(client.token, { to: '79005550074', text: 'Привет' });
    expect(accepted.statusCode).toBe(201);
    const id = accepted.json<{ message: MessageView }>().message.id;

    await stopFrom(secret, '79005550074');
    await api().get(MessagesService).dispatchDue(new Date());

    expect(await messageOf(client.token, id)).toMatchObject({
      status: 'failed',
      failure_reason: 'recipient_stopped',
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

describe('наценка правилами (ADR-0073)', () => {
  const addRule = (body: Record<string, unknown>) =>
    api().inject({
      method: 'POST',
      url: '/commission-rules',
      headers: bearer(adminToken),
      payload: body,
    });

  it('фикс за сообщение и доля применяются вместе: 0,45 + 10 % + 0,05 = 0,545', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const created = await addRule({
      product: 'message',
      fixedFee: '0.05',
      percentBasisPoints: 1000,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ rule: { product: string } }>().rule.product).toBe('message');

    const sent = (await send(client.token, { to: '79001234567', text: 'Привет' })).json<{
      message: MessageView;
    }>().message;
    expect(sent.cost).toBe('0.545');
    expect(await balance(client.token)).toBe('9.455');
  });

  it('правило клиента перебивает общее, а цена в кабинете считается по нему', async () => {
    await partnerWithAccount('0.45');
    const own = await clientWithMoney('10');
    const other = await clientWithMoney('10');
    expect((await addRule({ product: 'message', percentBasisPoints: 5000 })).statusCode).toBe(201);
    expect(
      (await addRule({ product: 'message', clientId: own.clientId, percentBasisPoints: 0 }))
        .statusCode,
    ).toBe(201);

    const price = (token: string) =>
      api().inject({ method: 'GET', url: '/client/messages/price', headers: bearer(token) });
    expect((await price(own.token)).json()).toMatchObject({ price: '0.45' });
    expect((await price(other.token)).json()).toMatchObject({ price: '0.675' });
  });

  it('новое правило уже принятое сообщение не переоценивает', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    const sent = (await send(client.token, { to: '79001234567', text: 'Привет' })).json<{
      message: MessageView;
    }>().message;
    expect(sent.cost).toBe('0.54');

    await addRule({ product: 'message', percentBasisPoints: 9000 });
    expect((await messageOf(client.token, sent.id))?.cost).toBe('0.54');
  });

  it('правила звонков и сообщений не смешиваются в списках; предел: 1000 % у сообщений, 100 % у звонков', async () => {
    const list = async (product: string) =>
      (
        await api().inject({
          method: 'GET',
          url: `/commission-rules?product=${product}`,
          headers: bearer(adminToken),
        })
      ).json<{ rules: { product: string }[] }>().rules;
    expect((await list('message')).every((rule) => rule.product === 'message')).toBe(true);
    expect((await list('call')).every((rule) => rule.product === 'call')).toBe(true);
    expect((await list('message')).length).toBeGreaterThanOrEqual(1);

    expect((await addRule({ product: 'message', percentBasisPoints: 100_000 })).statusCode).toBe(
      201,
    );
    expect((await addRule({ product: 'message', percentBasisPoints: 100_001 })).statusCode).toBe(
      400,
    );
    expect((await addRule({ product: 'call', percentBasisPoints: 10_001 })).statusCode).toBe(400);
    expect((await addRule({ product: 'другое', percentBasisPoints: 1 })).statusCode).toBe(400);
  });
});

describe('отчёт для сотрудников', () => {
  it('по клиенту и по аккаунту: ушло, причины отказов; клиенту закрыто', async () => {
    // Предыдущие проверки могли выключить предпроверку номеров: журнал проверок пишется, только когда она идёт.
    await put(adminToken, { 'messages.precheck_enabled': true });
    const partner = await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    // Результат проверки номера помнится в Redis (в том числе от прошлых прогонов): без этого настоящего запроса к провайдеру не было бы.
    await api()
      .get(RedisService)
      .connection.del('messaging:max:79005570011', 'messaging:max:79005570000');
    await send(client.token, { to: '79005570011', text: 'раз' });
    await send(client.token, { to: '79005570000', text: 'нет MAX' });
    await api().get(MessagesService).dispatchDue(new Date());

    const response = await api().inject({
      method: 'GET',
      url: '/messages/report?days=7',
      headers: bearer(adminToken),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      days: number;
      clients: { name: string; total: number; sent: number; failed: number; not_in_max: number }[];
      accounts: { label: string; partner_name: string; total: number; not_in_max: number }[];
    }>();
    expect(body.days).toBe(7);
    expect(body.clients).toHaveLength(1);
    expect(body.clients[0]).toMatchObject({ total: 2, sent: 1, failed: 1, not_in_max: 1 });
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({ total: 2, not_in_max: 1 });
    expect(body.accounts[0]?.partner_name).not.toBe('');

    // Журнал аккаунтов (ADR-0088): проверки номеров у провайдера без самих номеров; событие — аккаунт вышел из MAX и вернулся.
    simulateAccountState(partner.instance, 'not_authorized');
    await api()
      .get(MessagingService)
      .refreshDue(new Date(Date.now() + 10 * MINUTE));
    simulateAccountState(partner.instance, 'authorized', '79990003344');
    await api()
      .get(MessagingService)
      .refreshDue(new Date(Date.now() + 20 * MINUTE));
    const withJournal = (
      await api().inject({
        method: 'GET',
        url: '/messages/report?days=7',
        headers: bearer(adminToken),
      })
    ).json<{
      journal: {
        sent_via_accounts: number;
        blocked: number;
        accounts: {
          checks: { exists: number; absent: number };
          logged_out: number;
        }[];
        recent: { kind: string; reason: string | null }[];
      };
    }>().journal;
    expect(withJournal.sent_via_accounts).toBe(1);
    expect(withJournal.blocked).toBe(0);
    expect(withJournal.accounts).toHaveLength(1);
    expect(withJournal.accounts[0]?.checks).toMatchObject({ exists: 1, absent: 1 });
    expect(withJournal.accounts[0]?.logged_out).toBe(1);
    // Новые сверху: вернулся, вышел, а самое первое — вход аккаунта в MAX при заведении.
    expect(withJournal.recent.map((event) => event.kind)).toEqual([
      'active',
      'unavailable',
      'active',
    ]);
    expect(JSON.stringify(withJournal)).not.toMatch(/79005570011|79005570000/u);

    const denied = await api().inject({
      method: 'GET',
      url: '/messages/report',
      headers: bearer(client.token),
    });
    expect(denied.statusCode).toBe(403);
    const tooLong = await api().inject({
      method: 'GET',
      url: '/messages/report?days=400',
      headers: bearer(adminToken),
    });
    expect(tooLong.statusCode).toBe(400);
  });
});

describe('обзор для сотрудников', () => {
  it('сутки с нулями, принято/доставлено/не отправлено; деньги без возвращённых; клиенту закрыто', async () => {
    await partnerWithAccount('0.45');
    const client = await clientWithMoney('10');
    await send(client.token, { to: '79005550011', text: 'раз' });
    await send(client.token, { to: '79005550000', text: 'нет MAX' });
    await api().get(MessagesService).dispatchDue(new Date());

    const overview = await api().inject({
      method: 'GET',
      url: '/messages/overview?days=3&offset=0',
      headers: bearer(adminToken),
    });
    expect(overview.statusCode).toBe(200);
    const body = overview.json<{
      series: {
        day: string;
        messages: number;
        failed: number;
        revenue: string;
        margin: string;
      }[];
    }>();
    expect(body.series).toHaveLength(3);
    const today = body.series.at(-1);
    expect(today).toMatchObject({ messages: 2, failed: 1, revenue: '0.54', margin: '0.09' });
    expect(body.series[0]).toMatchObject({ messages: 0, revenue: '0' });

    const denied = await api().inject({
      method: 'GET',
      url: '/messages/overview',
      headers: bearer(client.token),
    });
    expect(denied.statusCode).toBe(403);
  });
});
