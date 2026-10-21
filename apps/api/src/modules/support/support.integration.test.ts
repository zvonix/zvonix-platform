/**
 * Обращения в поддержку на реальной базе (ADR-0085): автор и сотрудники, статусы, заметки, пределы, закрытие по сроку.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { TICKETS_PER_DAY } from '@zvonix/shared';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  withDatabase,
} from '../../testing/harness.js';
import { bearer, fixtures } from '../messaging/messaging.fixtures.js';
import { SupportService } from './support.service.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminToken = '';

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const fx = fixtures(api, () => adminToken);
const { user, put, clientWithMoney, partnerWithAccount } = fx;

/** Письма уходят только сотрудникам с подтверждённой почтой: отмечаем её напрямую в базе. */
const confirmEmail = (userId: string) =>
  withDatabase(async (execute) => {
    await execute(sql`update users set email_confirmed_at = now() where id = ${userId}`);
  });

interface TicketBody {
  ticket: { id: string; status: string; author_email: string };
  messages: { side: string; body: string; internal: boolean }[];
}

const call = (
  token: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
) =>
  api().inject({
    method,
    url,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload }),
  });

const newTicket = (token: string, cabinet: 'client' | 'partner', subject = 'Не приходит QR') =>
  call(token, 'POST', '/support/tickets', {
    cabinet,
    subject,
    category: 'bug',
    body: 'Опишу подробно, что не так',
  });

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  adminToken = (await user('admin')).token;
  // Аккаунт MAX партнёра (для проверки кабинета партнёра) заводится только при включённом продукте.
  expect((await put(adminToken, { 'messaging.enabled': true })).statusCode).toBe(200);
});

beforeEach(async () => {
  await withDatabase(async (execute) => {
    await execute(sql`delete from support_ticket_messages`);
    await execute(sql`delete from support_tickets`);
    await execute(sql`delete from outbox_messages`);
  });
  // Счётчики пределов — в Redis; у каждого теста свои люди, поэтому они не пересекаются.
});

afterAll(async () => {
  await app?.close();
});

describe('автор', () => {
  it('создаёт обращение, видит его и переписку; чужому оно «не найдено»', async () => {
    const client = await clientWithMoney('1');
    const stranger = await clientWithMoney('1');

    const created = await newTicket(client.token, 'client');
    expect(created.statusCode).toBe(201);
    const { ticket, messages } = created.json<TicketBody>();
    expect(ticket.status).toBe('open');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ side: 'user', internal: false });

    const list = await call(client.token, 'GET', '/support/tickets');
    expect(list.json<{ total: number }>().total).toBe(1);
    expect((await call(client.token, 'GET', `/support/tickets/${ticket.id}`)).statusCode).toBe(200);

    expect((await call(stranger.token, 'GET', `/support/tickets/${ticket.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (await call(stranger.token, 'GET', '/support/tickets')).json<{ total: number }>().total,
    ).toBe(0);
    expect((await call(client.token, 'GET', '/support/tickets/не-идентификатор')).statusCode).toBe(
      404,
    );
  });

  it('писать «из кабинета партнёра» может только партнёр', async () => {
    const client = await clientWithMoney('1');
    expect((await newTicket(client.token, 'partner')).statusCode).toBe(404);
    const partner = await partnerWithAccount('0.45');
    const mine = await newTicket(partner.ownerToken, 'partner');
    expect(mine.statusCode).toBe(201);
    expect((await newTicket(partner.ownerToken, 'client')).statusCode).toBe(404);
  });

  it('слишком короткие тема и текст — отказ', async () => {
    const client = await clientWithMoney('1');
    const response = await call(client.token, 'POST', '/support/tickets', {
      cabinet: 'client',
      subject: 'a',
      category: 'bug',
      body: 'b',
    });
    expect(response.statusCode).toBe(400);
  });

  it('больше десяти новых обращений в сутки — 429', async () => {
    const client = await clientWithMoney('1');
    for (let n = 0; n < TICKETS_PER_DAY; n += 1) {
      expect(
        (await newTicket(client.token, 'client', `Вопрос номер ${String(n)}`)).statusCode,
      ).toBe(201);
    }
    expect((await newTicket(client.token, 'client', 'Одиннадцатый')).statusCode).toBe(429);
  });

  it('закрывает своё обращение; в закрытое писать нельзя', async () => {
    const client = await clientWithMoney('1');
    const { ticket } = (await newTicket(client.token, 'client')).json<TicketBody>();
    const closed = await call(client.token, 'POST', `/support/tickets/${ticket.id}/close`);
    expect(closed.json<TicketBody>().ticket.status).toBe('closed');
    expect(
      (await call(client.token, 'POST', `/support/tickets/${ticket.id}/close`)).statusCode,
    ).toBe(409);
    const reply = await call(client.token, 'POST', `/support/tickets/${ticket.id}/messages`, {
      body: 'Ещё вопрос',
    });
    expect(reply.statusCode).toBe(409);
  });
});

describe('сотрудники', () => {
  it('отвечают: статус «ждём вас», автору уходит письмо, заметку автор не видит', async () => {
    const client = await clientWithMoney('1');
    const staff = await user('support');
    const { ticket } = (await newTicket(client.token, 'client')).json<TicketBody>();

    const answered = await call(
      staff.token,
      'POST',
      `/support/staff/tickets/${ticket.id}/messages`,
      {
        body: 'Посмотрели, пришлите время',
      },
    );
    expect(answered.statusCode).toBe(201);
    expect(answered.json<TicketBody>().ticket.status).toBe('waiting_user');

    await call(staff.token, 'POST', `/support/staff/tickets/${ticket.id}/messages`, {
      body: 'Похоже на лимит провайдера',
      internal: true,
    });

    const own = (
      await call(client.token, 'GET', `/support/tickets/${ticket.id}`)
    ).json<TicketBody>();
    expect(own.messages.map((m) => m.body)).toEqual([
      'Опишу подробно, что не так',
      'Посмотрели, пришлите время',
    ]);
    const full = (
      await call(staff.token, 'GET', `/support/staff/tickets/${ticket.id}`)
    ).json<TicketBody>();
    expect(full.messages).toHaveLength(3);
    expect(full.messages.some((m) => m.internal)).toBe(true);

    const mails = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select kind, recipient from outbox_messages where kind like 'ticket_reply:%'`,
      );
      return result.rows as { kind: string; recipient: string }[];
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]?.recipient).toBe(own.ticket.author_email);

    // Ответ автора возвращает обращение сотрудникам.
    const back = await call(client.token, 'POST', `/support/tickets/${ticket.id}/messages`, {
      body: 'Вчера в 15:00',
    });
    expect(back.json<TicketBody>().ticket.status).toBe('open');
  });

  it('новое обращение — письмо сотрудникам; повтор по тому же обращению в течение 15 минут не плодит писем', async () => {
    const staff = await user('support');
    await confirmEmail(staff.id);
    const client = await clientWithMoney('1');
    const { ticket } = (await newTicket(client.token, 'client')).json<TicketBody>();
    await call(client.token, 'POST', `/support/tickets/${ticket.id}/messages`, {
      body: 'Уточню ещё',
    });
    const rows = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select recipient from outbox_messages where kind = ${`ticket_staff:${ticket.id}`}`,
      );
      return result.rows as { recipient: string }[];
    });
    // Каждому сотруднику — одно письмо, а не два (повтор отсечён).
    const perRecipient = new Map<string, number>();
    for (const row of rows)
      perRecipient.set(row.recipient, (perRecipient.get(row.recipient) ?? 0) + 1);
    expect(perRecipient.size).toBeGreaterThanOrEqual(1);
    expect([...perRecipient.values()].every((n) => n === 1)).toBe(true);
    expect(staff.id).toBeTruthy();
  });

  it('очередь с отбором; взять в работу; сменить статус; журнал действий; закрытое не открывается', async () => {
    const client = await clientWithMoney('1');
    const staff = await user('support');
    const { ticket } = (await newTicket(client.token, 'client', 'Выплаты')).json<TicketBody>();
    await newTicket(client.token, 'client', 'Другое обращение');

    const found = await call(staff.token, 'GET', '/support/staff/tickets?q=выплат&cabinet=client');
    expect(found.json<{ total: number }>().total).toBe(1);
    expect(
      (await call(staff.token, 'GET', '/support/staff/tickets?status=resolved')).json<{
        total: number;
      }>().total,
    ).toBe(0);

    const taken = await call(staff.token, 'PATCH', `/support/staff/tickets/${ticket.id}/assignee`, {
      assignee: 'me',
    });
    // Взятое обращение «открыто» → «в работе».
    expect(taken.json<TicketBody>().ticket.status).toBe('in_progress');

    const resolved = await call(
      staff.token,
      'PATCH',
      `/support/staff/tickets/${ticket.id}/status`,
      {
        status: 'resolved',
      },
    );
    expect(resolved.json<TicketBody>().ticket.status).toBe('resolved');

    const actions = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select action from audit_log where entity_id = ${ticket.id} order by created_at`,
      );
      return (result.rows as { action: string }[]).map((row) => row.action);
    });
    expect(actions).toEqual(['support_ticket.assigned', 'support_ticket.status_changed']);

    await call(client.token, 'POST', `/support/tickets/${ticket.id}/close`);
    expect(
      (
        await call(staff.token, 'PATCH', `/support/staff/tickets/${ticket.id}/status`, {
          status: 'open',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call(staff.token, 'POST', `/support/staff/tickets/${ticket.id}/messages`, {
          body: 'Поздно отвечать',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('решённое обращение закрывается само через неделю', async () => {
    const client = await clientWithMoney('1');
    const staff = await user('support');
    const { ticket } = (await newTicket(client.token, 'client')).json<TicketBody>();
    await call(staff.token, 'PATCH', `/support/staff/tickets/${ticket.id}/status`, {
      status: 'resolved',
    });

    const service = api().get(SupportService);
    expect(await service.closeResolved(new Date())).toBe(0);
    await withDatabase(async (execute) => {
      await execute(
        sql`update support_tickets set last_message_at = now() - interval '8 days' where id = ${ticket.id}`,
      );
    });
    expect(await service.closeResolved(new Date())).toBe(1);
    const own = (
      await call(client.token, 'GET', `/support/tickets/${ticket.id}`)
    ).json<TicketBody>();
    expect(own.ticket.status).toBe('closed');
  });
});

describe('есть ответ поддержки и автозакрытие (ADR-0089)', () => {
  const unread = async (token: string) =>
    (await call(token, 'GET', '/support/tickets/unread')).json<{ total: number }>().total;

  it('ответ поддержки зажигает число у автора; открыл обращение — число гаснет; чужому и сотруднику недоступно', async () => {
    const client = await clientWithMoney('1');
    const other = await clientWithMoney('1');
    const staff = await user('support');
    const { ticket } = (await newTicket(client.token, 'client')).json<TicketBody>();
    expect(await unread(client.token)).toBe(0);

    await call(staff.token, 'POST', `/support/staff/tickets/${ticket.id}/messages`, {
      body: 'Посмотрели, ответ вам',
    });
    expect(await unread(client.token)).toBe(1);
    expect(await unread(other.token)).toBe(0);
    const list = (await call(client.token, 'GET', '/support/tickets')).json<{
      tickets: { status: string; unread: boolean }[];
    }>().tickets;
    expect(list[0]).toMatchObject({ status: 'waiting_user', unread: true });

    // Заметка сотрудников автору ничего не зажигает.
    await call(staff.token, 'POST', `/support/staff/tickets/${ticket.id}/messages`, {
      body: 'внутренняя',
      internal: true,
    });
    expect(await unread(client.token)).toBe(1);

    await call(client.token, 'GET', `/support/tickets/${ticket.id}`);
    expect(await unread(client.token)).toBe(0);

    // Новый ответ поддержки — снова число.
    await call(staff.token, 'POST', `/support/staff/tickets/${ticket.id}/messages`, {
      body: 'Ещё уточнение',
    });
    expect(await unread(client.token)).toBe(1);

    expect((await call(staff.token, 'GET', '/support/tickets/unread')).statusCode).toBe(403);
  });

  it('поддержка ответила, автор молчит — обращение закрывается само через срок из настройки; 0 — не закрывает; ответ автора сбрасывает отсчёт', async () => {
    const client = await clientWithMoney('1');
    const staff = await user('support');
    const { ticket } = (await newTicket(client.token, 'client')).json<TicketBody>();
    await call(staff.token, 'POST', `/support/staff/tickets/${ticket.id}/messages`, {
      body: 'Ответ поддержки',
    });
    const age = (days: number) =>
      withDatabase(async (execute) => {
        await execute(
          sql`update support_tickets set last_message_at = now() - make_interval(days => ${days}) where id = ${ticket.id}`,
        );
      });
    const status = async () =>
      (await call(client.token, 'GET', `/support/tickets/${ticket.id}`)).json<TicketBody>().ticket
        .status;
    const service = api().get(SupportService);

    // По умолчанию семь суток: шесть ещё рано.
    await age(6);
    expect(await service.closeResolved(new Date())).toBe(0);
    expect(await status()).toBe('waiting_user');

    // Срок 3 суток — шесть уже много.
    expect((await put(adminToken, { 'support.autoclose_days': 3 })).statusCode).toBe(200);
    // Ответ автора до срока возвращает обращение в работу, отсчёт начинается заново.
    await call(client.token, 'POST', `/support/tickets/${ticket.id}/messages`, { body: 'Я тут' });
    expect(await service.closeResolved(new Date())).toBe(0);
    expect(await status()).toBe('open');

    // 0 — само не закрывается никогда.
    expect((await put(adminToken, { 'support.autoclose_days': 0 })).statusCode).toBe(200);
    await call(staff.token, 'POST', `/support/staff/tickets/${ticket.id}/messages`, {
      body: 'Ответили ещё раз',
    });
    await age(400);
    expect(await service.closeResolved(new Date())).toBe(0);

    expect((await put(adminToken, { 'support.autoclose_days': 3 })).statusCode).toBe(200);
    expect(await service.closeResolved(new Date())).toBe(1);
    expect(await status()).toBe('closed');
    const audited = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select action from audit_log where action = 'support_ticket.auto_closed' and entity_id = ${ticket.id}`,
      );
      return result.rows.length;
    });
    expect(audited).toBe(1);
    expect((await put(adminToken, { 'support.autoclose_days': 7 })).statusCode).toBe(200);
  });
});

describe('доступ', () => {
  it('сотрудникам закрыт путь автора, автору — путь сотрудников', async () => {
    const client = await clientWithMoney('1');
    const staff = await user('support');
    expect((await call(staff.token, 'GET', '/support/tickets')).statusCode).toBe(403);
    expect((await call(client.token, 'GET', '/support/staff/tickets')).statusCode).toBe(403);
    expect((await api().inject({ method: 'GET', url: '/support/tickets' })).statusCode).toBe(401);
  });
});
