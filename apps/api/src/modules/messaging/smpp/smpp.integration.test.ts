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
