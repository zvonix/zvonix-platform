/**
 * SMPP на реальной базе и настоящем сокете (ADR-0072): вход и отказы, приём сообщения с деньгами,
 * кодировки и длинный текст, отчёты о доставке, защита от перебора.
 */

import net from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  prepareEnvironment,
  resetDatabase,
  startApi,
  withDatabase,
} from '../../../testing/harness.js';
import { MessagesService } from '../messages.service.js';
import { bearer, fixtures } from '../messaging.fixtures.js';
import {
  bindBody,
  Command,
  decodeMessageId,
  decodeReceiptText,
  encodePdu,
  encodeResponse,
  encodeSubmitBody,
  PduFramer,
  Status,
  type Pdu,
} from './codec.js';
import { SmppServer } from './server.js';

prepareEnvironment();

let app: NestFastifyApplication | undefined;
let adminToken = '';
let port = 0;

function api(): NestFastifyApplication {
  if (app === undefined) throw new Error('Приложение не поднято');
  return app;
}

const fx = fixtures(api, () => adminToken);

/** Минимальный клиент SMPP для проверок. */
class Esme {
  private readonly framer = new PduFramer();
  private readonly waiting = new Map<number, (pdu: Pdu) => void>();
  readonly received: Pdu[] = [];
  private sequence = 1;
  closed = false;
  private readonly socket: net.Socket;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      for (const pdu of this.framer.push(chunk)) {
        const waiter = this.waiting.get(pdu.sequence);
        if (waiter !== undefined && pdu.commandId >= 0x80000000) {
          this.waiting.delete(pdu.sequence);
          waiter(pdu);
        } else {
          this.received.push(pdu);
        }
      }
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {
      this.closed = true;
    });
  }

  static connect(): Promise<Esme> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        resolve(new Esme(socket));
      });
      socket.once('error', reject);
    });
  }

  /** Посылает операцию и ждёт ответ с тем же номером. */
  request(commandId: number, body: Buffer = Buffer.alloc(0)): Promise<Pdu> {
    const sequence = this.sequence++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Нет ответа на операцию ${commandId.toString(16)}`));
      }, 5000);
      this.waiting.set(sequence, (pdu) => {
        clearTimeout(timer);
        resolve(pdu);
      });
      this.socket.write(encodePdu(commandId, 0, sequence, body));
    });
  }

  bind(command: number, systemId: string, password: string): Promise<Pdu> {
    return this.request(command, bindBody(systemId, password));
  }

  submit(destination: string, text: string, extra: { dataCoding?: number } = {}): Promise<Pdu> {
    return this.request(
      Command.submitSm,
      encodeSubmitBody({ destination, text, dataCoding: extra.dataCoding ?? 8 }),
    );
  }

  /** Ответ на присланную сервером операцию (например `deliver_sm`). */
  ack(pdu: Pdu, status: number = Status.ok): void {
    this.socket.write(encodeResponse(pdu.commandId, status, pdu.sequence, Buffer.from([0])));
  }

  async untilReceived(count: number): Promise<Pdu[]> {
    const deadline = Date.now() + 5000;
    while (this.received.length < count) {
      if (Date.now() > deadline) throw new Error('Не дождались операции от сервера');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.received;
  }

  async untilClosed(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('Соединение не закрыто');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  destroy(): void {
    this.socket.destroy();
  }
}

const open: Esme[] = [];
async function connect(): Promise<Esme> {
  const esme = await Esme.connect();
  open.push(esme);
  return esme;
}

interface Credentials {
  systemId: string;
  password: string;
}

/** Клиент с деньгами и подключением SMPP, созданным через кабинет. */
async function smppClient(amount = '50'): Promise<{
  client: Awaited<ReturnType<typeof fx.clientWithMoney>>;
  credentials: Credentials;
}> {
  const client = await fx.clientWithMoney(amount);
  const created = await api().inject({
    method: 'POST',
    url: '/client/messages/smpp',
    headers: bearer(client.token),
  });
  expect(created.statusCode).toBe(201);
  const body = created.json<{ smpp: { system_id: string }; password: string }>();
  return { client, credentials: { systemId: body.smpp.system_id, password: body.password } };
}

interface MessageRow {
  id: string;
  recipient: string;
  text: string;
  channel: string;
  status: string;
  receipt_sent_at: Date | null;
}

const messagesOf = (clientId: string): Promise<MessageRow[]> =>
  withDatabase(async (execute) => {
    const result = await execute(
      sql`select id, recipient, text, channel, status, receipt_sent_at from messages where client_id = ${clientId} order by created_at`,
    );
    return result.rows as unknown as MessageRow[];
  });

beforeAll(async () => {
  await resetDatabase();
  app = await startApi();
  adminToken = (await fx.user('admin')).token;
  expect((await fx.put(adminToken, { 'messaging.enabled': true })).statusCode).toBe(200);
  expect((await fx.put(adminToken, { 'messages.pace_seconds': 0 })).statusCode).toBe(200);
  port = await api().get(SmppServer).listen({ host: '127.0.0.1', port: 0 });
});

beforeEach(async () => {
  await withDatabase(async (execute) => {
    await execute(sql`delete from messages`);
    await execute(sql`delete from messenger_accounts`);
  });
});

afterEach(() => {
  for (const esme of open.splice(0)) esme.destroy();
  // Адрес стенда один на все проверки: неудачные входы одной не должны запирать следующую.
  api().get(SmppServer)['failures'].clear();
});

afterAll(async () => {
  await api().get(SmppServer).stop();
  await app?.close();
});

describe('подключение клиента в кабинете', () => {
  it('создаётся один раз; пароль виден только в ответе создания; новый пароль заменяет прежний', async () => {
    const client = await fx.clientWithMoney('1');
    const get = () =>
      api().inject({ method: 'GET', url: '/client/messages/smpp', headers: bearer(client.token) });

    expect((await get()).json()).toMatchObject({ enabled: true, smpp: null });

    const created = await api().inject({
      method: 'POST',
      url: '/client/messages/smpp',
      headers: bearer(client.token),
    });
    expect(created.statusCode).toBe(201);
    const first = created.json<{ smpp: { system_id: string }; password: string }>();
    expect(first.password).toHaveLength(16);
    expect(first.smpp.system_id).toMatch(/^zx[a-z0-9]{8}$/u);

    const read = await get();
    expect(JSON.stringify(read.json())).not.toContain(first.password);

    const again = await api().inject({
      method: 'POST',
      url: '/client/messages/smpp',
      headers: bearer(client.token),
    });
    expect(again.statusCode).toBe(409);

    const reset = await api().inject({
      method: 'POST',
      url: '/client/messages/smpp/password',
      headers: bearer(client.token),
    });
    const second = reset.json<{ password: string }>();
    expect(second.password).not.toBe(first.password);

    const old = await connect();
    const refused = await old.bind(Command.bindTransceiver, first.smpp.system_id, first.password);
    expect(refused.status).toBe(Status.invalidPassword);
    const fresh = await connect();
    expect(
      (await fresh.bind(Command.bindTransceiver, first.smpp.system_id, second.password)).status,
    ).toBe(Status.ok);
  });

  it('список адресов проверяется: чужое слово не адрес, пустой — «любые»', async () => {
    const { client } = await smppClient('1');
    const bad = await api().inject({
      method: 'PATCH',
      url: '/client/messages/smpp',
      headers: bearer(client.token),
      payload: { allowedIps: ['не-адрес'] },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await api().inject({
      method: 'PATCH',
      url: '/client/messages/smpp',
      headers: bearer(client.token),
      payload: { allowedIps: ['10.0.0.1', '::ffff:10.0.0.2'] },
    });
    expect(ok.json<{ smpp: { allowed_ips: string[] } }>().smpp.allowed_ips).toEqual([
      '10.0.0.1',
      '10.0.0.2',
    ]);
  });
});

describe('подключения у сотрудников', () => {
  it('сотрудники видят подключения; администратор отключает — вход закрывается, возвращает — открывается; поддержка и клиент не меняют', async () => {
    const { client, credentials } = await smppClient('5');

    const list = await api().inject({
      method: 'GET',
      url: '/smpp/accounts',
      headers: bearer(adminToken),
    });
    expect(list.statusCode).toBe(200);
    const found = list
      .json<{ accounts: { client_id: string; system_id: string; enabled: boolean }[] }>()
      .accounts.find((account) => account.client_id === client.clientId);
    expect(found).toMatchObject({ system_id: credentials.systemId, enabled: true });
    // Пароль не уходит никому, кроме самого клиента при создании.
    expect(list.body).not.toContain(credentials.password);

    const off = await api().inject({
      method: 'PATCH',
      url: `/smpp/accounts/${client.clientId}`,
      headers: bearer(adminToken),
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    const blocked = await connect();
    expect(
      (await blocked.bind(Command.bindTransceiver, credentials.systemId, credentials.password))
        .status,
    ).toBe(Status.bindFailed);

    const support = await fx.user('support');
    expect(
      (
        await api().inject({
          method: 'GET',
          url: '/smpp/accounts',
          headers: bearer(support.token),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await api().inject({
          method: 'PATCH',
          url: `/smpp/accounts/${client.clientId}`,
          headers: bearer(support.token),
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await api().inject({
          method: 'GET',
          url: '/smpp/accounts',
          headers: bearer(client.token),
        })
      ).statusCode,
    ).toBe(403);

    await api().inject({
      method: 'PATCH',
      url: `/smpp/accounts/${client.clientId}`,
      headers: bearer(adminToken),
      payload: { enabled: true },
    });
    const open = await connect();
    expect(
      (await open.bind(Command.bindTransceiver, credentials.systemId, credentials.password)).status,
    ).toBe(Status.ok);
  });
});

describe('вход', () => {
  it('верные данные — вход; неверный пароль — отказ и закрытие соединения', async () => {
    const { credentials } = await smppClient();
    const good = await connect();
    expect(
      (await good.bind(Command.bindTransceiver, credentials.systemId, credentials.password)).status,
    ).toBe(Status.ok);

    const bad = await connect();
    expect((await bad.bind(Command.bindTransceiver, credentials.systemId, 'неверный')).status).toBe(
      Status.invalidPassword,
    );
    await bad.untilClosed();
  });

  it('неизвестное имя отвечает так же, как неверный пароль', async () => {
    const esme = await connect();
    const response = await esme.bind(Command.bindTransmitter, 'zxnosuchid1', 'x');
    expect(response.status).toBe(Status.invalidPassword);
  });

  it('адрес вне списка, отключённая запись, остановленный клиент — отказ без подробностей', async () => {
    const { client, credentials } = await smppClient();

    await api().inject({
      method: 'PATCH',
      url: '/client/messages/smpp',
      headers: bearer(client.token),
      payload: { allowedIps: ['203.0.113.9'] },
    });
    expect(
      (
        await (
          await connect()
        ).bind(Command.bindTransceiver, credentials.systemId, credentials.password)
      ).status,
    ).toBe(Status.bindFailed);

    await api().inject({
      method: 'PATCH',
      url: '/client/messages/smpp',
      headers: bearer(client.token),
      payload: { allowedIps: [], enabled: false },
    });
    expect(
      (
        await (
          await connect()
        ).bind(Command.bindTransceiver, credentials.systemId, credentials.password)
      ).status,
    ).toBe(Status.bindFailed);

    await api().inject({
      method: 'PATCH',
      url: '/client/messages/smpp',
      headers: bearer(client.token),
      payload: { enabled: true },
    });
    await api().inject({
      method: 'PATCH',
      url: `/clients/${client.clientId}/status`,
      headers: bearer(adminToken),
      payload: { status: 'suspended' },
    });
    expect(
      (
        await (
          await connect()
        ).bind(Command.bindTransceiver, credentials.systemId, credentials.password)
      ).status,
    ).toBe(Status.bindFailed);
  });

  it('до входа можно только проверять связь; после входа второй вход — отказ', async () => {
    const { credentials } = await smppClient();
    const esme = await connect();
    expect((await esme.request(Command.enquireLink)).status).toBe(Status.ok);
    expect((await esme.submit('79001234567', 'привет')).status).toBe(Status.incorrectBindStatus);

    await esme.bind(Command.bindTransceiver, credentials.systemId, credentials.password);
    expect(
      (await esme.bind(Command.bindTransceiver, credentials.systemId, credentials.password)).status,
    ).toBe(Status.alreadyBound);
  });

  it('пять неверных входов с одного адреса — адрес на время не принимается', async () => {
    const { credentials } = await smppClient();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const esme = await connect();
      await esme.bind(Command.bindTransceiver, credentials.systemId, `wrong${String(attempt)}`);
    }
    // Даже верный пароль не пройдёт: соединение закрывается сразу.
    const blocked = await connect();
    await blocked.untilClosed();
  });
});

describe('приём сообщения', () => {
  it('submit_sm становится сообщением: деньги списаны, идентификатор в ответе, путь — smpp', async () => {
    await fx.partnerWithAccount('0.45');
    const { client, credentials } = await smppClient('10');
    const esme = await connect();
    await esme.bind(Command.bindTransmitter, credentials.systemId, credentials.password);

    const response = await esme.submit('79001234567', 'Ваш код 4321');
    expect(response.status).toBe(Status.ok);

    const [row] = await messagesOf(client.clientId);
    expect(row).toMatchObject({
      recipient: '79001234567',
      text: 'Ваш код 4321',
      channel: 'smpp',
      status: 'queued',
    });
    expect(decodeMessageId(response.body)).toBe(row?.id);
    expect(await fx.balance(client.token)).toBe('9.46');
  });

  it('кириллица в UCS-2 и в UTF-8 доходит без искажений', async () => {
    await fx.partnerWithAccount('0.45');
    const { client, credentials } = await smppClient('10');
    const esme = await connect();
    await esme.bind(Command.bindTransmitter, credentials.systemId, credentials.password);

    await esme.submit('79001234567', 'Привет, мир', { dataCoding: 8 });
    await esme.submit('79001234568', 'Заказ №5', { dataCoding: 0 });
    expect((await messagesOf(client.clientId)).map((row) => row.text)).toEqual([
      'Привет, мир',
      'Заказ №5',
    ]);
  });

  it('длинный текст по частям склеивается в одно сообщение и списывается один раз', async () => {
    await fx.partnerWithAccount('0.45');
    const { client, credentials } = await smppClient('10');
    const esme = await connect();
    await esme.bind(Command.bindTransmitter, credentials.systemId, credentials.password);

    const part = (sequence: number, text: string) =>
      esme.request(
        Command.submitSm,
        encodeSubmitBody({
          destination: '79001234567',
          text,
          part: { reference: 42, total: 2, sequence },
        }),
      );
    const first = await part(1, 'Первая часть. ');
    expect(first.status).toBe(Status.ok);
    expect(await messagesOf(client.clientId)).toHaveLength(0);

    const second = await part(2, 'Вторая часть.');
    expect(second.status).toBe(Status.ok);
    const rows = await messagesOf(client.clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe('Первая часть. Вторая часть.');
    expect(decodeMessageId(second.body)).toBe(rows[0]?.id);
    expect(await fx.balance(client.token)).toBe('9.46');
  });

  it('отказы получают коды протокола: плохой номер, пустой текст, нет денег, нет аккаунтов', async () => {
    const { credentials } = await smppClient('10');
    const esme = await connect();
    await esme.bind(Command.bindTransmitter, credentials.systemId, credentials.password);

    expect((await esme.submit('12', 'текст')).status).toBe(Status.invalidDestination);
    expect((await esme.submit('79001234567', '   ')).status).toBe(Status.invalidMessageLength);
    // Аккаунтов партнёров нет — принять некуда.
    expect((await esme.submit('79001234567', 'текст')).status).toBe(Status.throttled);

    await fx.partnerWithAccount('0.45');
    const poor = await smppClient('0');
    const broke = await connect();
    await broke.bind(Command.bindTransmitter, poor.credentials.systemId, poor.credentials.password);
    expect((await broke.submit('79001234567', 'текст')).status).toBe(Status.submitFailed);
  });

  it('на приёмнике отправлять нельзя', async () => {
    const { credentials } = await smppClient();
    const esme = await connect();
    await esme.bind(Command.bindReceiver, credentials.systemId, credentials.password);
    expect((await esme.submit('79001234567', 'текст')).status).toBe(Status.incorrectBindStatus);
  });

  it('частота выше предела получает «слишком часто», а не падение', async () => {
    await fx.partnerWithAccount('0.01');
    const { credentials } = await smppClient('100');
    const esme = await connect();
    await esme.bind(Command.bindTransmitter, credentials.systemId, credentials.password);

    const results = await Promise.all(
      Array.from({ length: 70 }, (_unused, index) =>
        esme.submit('79001234567', `сообщение ${String(index)}`),
      ),
    );
    const statuses = results.map((pdu) => pdu.status);
    expect(statuses.filter((status) => status === Status.ok).length).toBeGreaterThanOrEqual(50);
    expect(statuses).toContain(Status.throttled);
  });
});

describe('отчёты о доставке', () => {
  it('доставлено — клиенту приходит deliver_sm; после подтверждения повторно не шлётся', async () => {
    const partner = await fx.partnerWithAccount('0.45');
    const { client, credentials } = await smppClient('10');
    const esme = await connect();
    await esme.bind(Command.bindTransceiver, credentials.systemId, credentials.password);
    await esme.submit('79005550011', 'Ваш заказ принят');

    await api().get(MessagesService).dispatchDue(new Date());
    const [sent] = await messagesOf(client.clientId);
    const providerId = await withDatabase(async (execute) => {
      const result = await execute(
        sql`select provider_message_id as id from messages where id = ${sent?.id ?? ''}`,
      );
      return (result.rows[0] as { id: string }).id;
    });
    // Отправлено — отчёта ещё нет.
    expect(await api().get(SmppServer).deliverReceipts()).toBe(0);

    await api().get(MessagesService).applyDeliveryStatus(partner.instance, providerId, 'delivered');
    expect(await api().get(SmppServer).deliverReceipts()).toBe(1);

    const [receipt] = await esme.untilReceived(1);
    expect(receipt?.commandId).toBe(Command.deliverSm);
    const text = decodeReceiptText(receipt?.body ?? Buffer.alloc(0));
    expect(text).toContain(`id:${sent?.id ?? ''}`);
    expect(text).toContain('stat:DELIVRD');
    if (receipt === undefined) throw new Error('Отчёта нет');
    esme.ack(receipt);

    // Отметка ставится после подтверждения клиента.
    const deadline = Date.now() + 5000;
    for (;;) {
      const [row] = await messagesOf(client.clientId);
      if (row?.receipt_sent_at !== null) break;
      if (Date.now() > deadline) throw new Error('Отчёт не отмечен отданным');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await api().get(SmppServer).deliverReceipts()).toBe(0);
  });

  it('не отправлено — отчёт «не доставлено» с нашей причиной; без подтверждения отдаётся снова', async () => {
    await fx.partnerWithAccount('0.45');
    const { credentials } = await smppClient('10');
    const esme = await connect();
    await esme.bind(Command.bindTransceiver, credentials.systemId, credentials.password);
    await esme.submit('79005550000', 'Привет');
    await api().get(MessagesService).dispatchDue(new Date());

    expect(await api().get(SmppServer).deliverReceipts()).toBe(1);
    const [receipt] = await esme.untilReceived(1);
    const text = decodeReceiptText(receipt?.body ?? Buffer.alloc(0));
    expect(text).toContain('stat:UNDELIV');
    expect(text).toContain('err:001');
    // Клиент не подтвердил и пропал: отчёт не потерян — придёт при следующем входе.
    esme.destroy();
    await esme.untilClosed();

    const again = await connect();
    await again.bind(Command.bindReceiver, credentials.systemId, credentials.password);
    const deadline = Date.now() + 5000;
    while (again.received.length === 0) {
      await api().get(SmppServer).deliverReceipts();
      if (Date.now() > deadline) throw new Error('Отчёт не пришёл после повторного входа');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(again.received[0]?.commandId).toBe(Command.deliverSm);
  });

  describe('настройки отчётов (ADR-0076)', () => {
    const setReceipts = (token: string, receipts: Record<string, string>) =>
      api().inject({
        method: 'PATCH',
        url: '/client/messages/smpp',
        headers: bearer(token),
        payload: { receipts },
      });

    const providerIdOf = (messageId: string): Promise<string> =>
      withDatabase(async (execute) => {
        const result = await execute(
          sql`select provider_message_id as id from messages where id = ${messageId}`,
        );
        return (result.rows[0] as { id: string }).id;
      });

    const handled = new WeakMap<Esme, number>();

    /** Крутит опрос, подтверждает приходящие отчёты и возвращает тексты новых (всего должно быть `total`); потом убеждается, что лишнего нет. */
    async function drain(esme: Esme, total: number): Promise<string[]> {
      const texts: string[] = [];
      const deadline = Date.now() + 5000;
      let seen = handled.get(esme) ?? 0;
      while (seen < total) {
        await api().get(SmppServer).deliverReceipts();
        while (seen < esme.received.length) {
          const receipt = esme.received[seen];
          if (receipt === undefined) break;
          texts.push(decodeReceiptText(receipt.body));
          esme.ack(receipt);
          seen += 1;
        }
        if (Date.now() > deadline) throw new Error('Отчётов пришло меньше, чем ждали');
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      for (let pass = 0; pass < 3; pass += 1) {
        await api().get(SmppServer).deliverReceipts();
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      handled.set(esme, seen);
      expect(esme.received).toHaveLength(total);
      return texts;
    }

    it('настройки видны в подключении, неверное значение отвергается, смена пишется в журнал', async () => {
      const { client } = await smppClient('10');
      const view = (
        await api().inject({
          method: 'GET',
          url: '/client/messages/smpp',
          headers: bearer(client.token),
        })
      ).json<{ smpp: { receipts: Record<string, string> } }>();
      expect(view.smpp.receipts).toEqual({
        sent: 'none',
        delivered: 'delivered',
        read: 'delivered',
      });

      expect(
        (await setReceipts(client.token, { sent: 'maybe', delivered: 'none', read: 'none' }))
          .statusCode,
      ).toBe(400);
      const changed = await setReceipts(client.token, {
        sent: 'accepted',
        delivered: 'delivered',
        read: 'none',
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json<{ smpp: { receipts: unknown } }>().smpp.receipts).toEqual({
        sent: 'accepted',
        delivered: 'delivered',
        read: 'none',
      });
      const logged = await withDatabase(async (execute) => {
        const result = await execute(
          sql`select count(*)::int as n from audit_log where action = 'smpp_account.updated'`,
        );
        return (result.rows[0] as { n: number }).n;
      });
      expect(logged).toBeGreaterThanOrEqual(1);
    });

    it('«сразу, как ушло»: отчёт DELIVRD приходит при отправке, дальнейшие события молчат', async () => {
      const partner = await fx.partnerWithAccount('0.45');
      const { client, credentials } = await smppClient('10');
      await setReceipts(client.token, { sent: 'delivered', delivered: 'none', read: 'none' });
      const esme = await connect();
      await esme.bind(Command.bindTransceiver, credentials.systemId, credentials.password);
      await esme.submit('79005550021', 'Подача');
      await api().get(MessagesService).dispatchDue(new Date());

      const [first] = await drain(esme, 1);
      expect(first).toContain('stat:DELIVRD');

      const [message] = await messagesOf(client.clientId);
      const providerId = await providerIdOf(message?.id ?? '');
      await api()
        .get(MessagesService)
        .applyDeliveryStatus(partner.instance, providerId, 'delivered');
      await api().get(MessagesService).applyDeliveryStatus(partner.instance, providerId, 'read');
      await drain(esme, 1);
    });

    it('«принято, затем доставлено»: ACCEPTD, потом один DELIVRD — «прочитано» тот же итог не повторяет', async () => {
      const partner = await fx.partnerWithAccount('0.45');
      const { client, credentials } = await smppClient('10');
      await setReceipts(client.token, {
        sent: 'accepted',
        delivered: 'delivered',
        read: 'delivered',
      });
      const esme = await connect();
      await esme.bind(Command.bindTransceiver, credentials.systemId, credentials.password);
      await esme.submit('79005550022', 'Подача');
      await api().get(MessagesService).dispatchDue(new Date());

      const [accepted] = await drain(esme, 1);
      expect(accepted).toContain('stat:ACCEPTD');

      const [message] = await messagesOf(client.clientId);
      const providerId = await providerIdOf(message?.id ?? '');
      // Доставлено и прочитано пришли подряд: клиент получает один DELIVRD.
      await api()
        .get(MessagesService)
        .applyDeliveryStatus(partner.instance, providerId, 'delivered');
      await api().get(MessagesService).applyDeliveryStatus(partner.instance, providerId, 'read');
      const texts = await drain(esme, 2);
      expect(texts[0]).toContain('stat:DELIVRD');
    });

    it('отказ приходит всегда, даже если на все события выбрано «ничего»', async () => {
      await fx.partnerWithAccount('0.45');
      const { client, credentials } = await smppClient('10');
      await setReceipts(client.token, { sent: 'none', delivered: 'none', read: 'none' });
      const esme = await connect();
      await esme.bind(Command.bindTransceiver, credentials.systemId, credentials.password);
      await esme.submit('79005550000', 'Нет MAX');
      await api().get(MessagesService).dispatchDue(new Date());

      const [text] = await drain(esme, 1);
      expect(text).toContain('stat:UNDELIV');
    });
  });

  it('отчёт получает только владелец сообщения', async () => {
    await fx.partnerWithAccount('0.45');
    const sender = await smppClient('10');
    const other = await smppClient('10');
    const mine = await connect();
    await mine.bind(
      Command.bindTransceiver,
      sender.credentials.systemId,
      sender.credentials.password,
    );
    const stranger = await connect();
    await stranger.bind(
      Command.bindReceiver,
      other.credentials.systemId,
      other.credentials.password,
    );
    await mine.submit('79005550000', 'Привет');
    await api().get(MessagesService).dispatchDue(new Date());

    expect(await api().get(SmppServer).deliverReceipts()).toBe(1);
    await mine.untilReceived(1);
    expect(stranger.received).toHaveLength(0);
  });
});
