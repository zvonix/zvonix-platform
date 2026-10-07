/**
 * Разбор и сборка PDU протокола SMPP 3.4 ([ADR-0072](../../../../../../docs/adr/0072-smpp-dlya-soobscheniy.md)).
 *
 * Нужна малая часть протокола: вход (`bind_*`), приём сообщения (`submit_sm`), отчёт о доставке
 * (`deliver_sm`), проверка связи и выход. Всё чужое — это `generic_nack` от сервера, а не молчание.
 * Байты, пришедшие с сети, недоверенные: любое выходящее за границы чтение — ошибка протокола.
 */

/** Коды операций. Ответ — тот же код с установленным старшим битом. */
export const Command = {
  genericNack: 0x80000000,
  bindReceiver: 0x00000001,
  bindTransmitter: 0x00000002,
  submitSm: 0x00000004,
  deliverSm: 0x00000005,
  unbind: 0x00000006,
  bindTransceiver: 0x00000009,
  enquireLink: 0x00000015,
} as const;

export const RESPONSE_BIT = 0x80000000;

/** Коды результата (`command_status`). */
export const Status = {
  ok: 0x00,
  invalidMessageLength: 0x01,
  invalidCommandLength: 0x02,
  invalidCommandId: 0x03,
  incorrectBindStatus: 0x04,
  alreadyBound: 0x05,
  systemError: 0x08,
  invalidDestination: 0x0b,
  bindFailed: 0x0d,
  invalidPassword: 0x0e,
  invalidSystemId: 0x0f,
  submitFailed: 0x45,
  throttled: 0x58,
} as const;

/** Опциональные параметры (TLV), которые мы читаем или пишем. */
const Tag = {
  receiptedMessageId: 0x001e,
  sarMsgRefNum: 0x020c,
  sarTotalSegments: 0x020e,
  sarSegmentSeqnum: 0x020f,
  messageState: 0x0427,
  messagePayload: 0x0424,
} as const;

const HEADER_BYTES = 16;
/** Предел длины PDU: настоящие не больше нескольких килобайт, а большой — это попытка занять память. */
const MAX_PDU_BYTES = 65_536;

export interface Pdu {
  readonly commandId: number;
  readonly status: number;
  readonly sequence: number;
  readonly body: Buffer;
}

/** Ошибка протокола: ответ с этим кодом (если ответ вообще возможен). */
export class SmppProtocolError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SmppProtocolError';
  }
}

/**
 * Собирает PDU из потока байт: сообщения приходят кусками и склеенными. Слишком короткая или слишком
 * длинная длина — ошибка протокола: дальше по такому потоку разобрать нечего, соединение закрывают.
 */
export class PduFramer {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Pdu[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const out: Pdu[] = [];
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length < HEADER_BYTES || length > MAX_PDU_BYTES) {
        throw new SmppProtocolError(Status.invalidCommandLength, 'Недопустимая длина PDU');
      }
      if (this.pending.length < length) break;
      out.push({
        commandId: this.pending.readUInt32BE(4),
        status: this.pending.readUInt32BE(8),
        sequence: this.pending.readUInt32BE(12),
        body: this.pending.subarray(HEADER_BYTES, length),
      });
      this.pending = this.pending.subarray(length);
    }
    return out;
  }
}

export function encodePdu(
  commandId: number,
  status: number,
  sequence: number,
  body: Buffer,
): Buffer {
  const out = Buffer.alloc(HEADER_BYTES + body.length);
  out.writeUInt32BE(out.length, 0);
  out.writeUInt32BE(commandId >>> 0, 4);
  out.writeUInt32BE(status >>> 0, 8);
  out.writeUInt32BE(sequence >>> 0, 12);
  body.copy(out, HEADER_BYTES);
  return out;
}

/** Ответ на операцию; тело — как положено операции (у bind и submit_sm — строка). */
export function encodeResponse(
  request: number,
  status: number,
  sequence: number,
  body: Buffer = Buffer.alloc(0),
): Buffer {
  return encodePdu((request | RESPONSE_BIT) >>> 0, status, sequence, body);
}

/** Строка с нулём в конце. */
export const cString = (value: string): Buffer =>
  Buffer.concat([Buffer.from(value, 'latin1'), Buffer.from([0])]);

/** Читатель тела PDU: каждое чтение проверяет границы. */
class Reader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  byte(): number {
    const value = this.buffer[this.offset];
    if (value === undefined)
      throw new SmppProtocolError(Status.invalidMessageLength, 'PDU оборвано');
    this.offset += 1;
    return value;
  }

  /** Строка до нуля, не длиннее `max` знаков (с нулём — `max + 1` байт). */
  cString(max: number): string {
    let end = this.offset;
    while (end < this.buffer.length && this.buffer[end] !== 0) end += 1;
    if (end >= this.buffer.length || end - this.offset > max) {
      throw new SmppProtocolError(
        Status.invalidMessageLength,
        'Строка PDU без конца или длиннее допустимого',
      );
    }
    const value = this.buffer.toString('latin1', this.offset, end);
    this.offset = end + 1;
    return value;
  }

  bytes(length: number): Buffer {
    if (length > this.remaining) {
      throw new SmppProtocolError(Status.invalidMessageLength, 'PDU оборвано');
    }
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  uint16(): number {
    return (this.byte() << 8) | this.byte();
  }

  rest(): Buffer {
    return this.bytes(this.remaining);
  }
}

export interface BindRequest {
  readonly systemId: string;
  readonly password: string;
}

export function decodeBind(body: Buffer): BindRequest {
  const reader = new Reader(body);
  const systemId = reader.cString(16);
  const password = reader.cString(64);
  return { systemId, password };
}

export interface SubmitRequest {
  readonly destination: string;
  readonly esmClass: number;
  readonly dataCoding: number;
  readonly registeredDelivery: number;
  /** Текст целиком, либо часть длинного текста — тогда `part` заполнено. */
  readonly text: string;
  readonly part?: ConcatPart;
}

/** Часть длинного текста: набор по `reference` собирается, когда пришли все `total` частей. */
interface ConcatPart {
  readonly reference: number;
  readonly total: number;
  readonly sequence: number;
}

/** Разбирает `submit_sm` до текста и признаков частей. Что не поддерживается — `SmppProtocolError`. */
export function decodeSubmit(body: Buffer): SubmitRequest {
  const reader = new Reader(body);
  reader.cString(5); // service_type
  reader.byte(); // source_addr_ton
  reader.byte(); // source_addr_npi
  reader.cString(20); // source_addr
  reader.byte(); // dest_addr_ton
  reader.byte(); // dest_addr_npi
  const destination = reader.cString(20);
  const esmClass = reader.byte();
  reader.byte(); // protocol_id
  reader.byte(); // priority_flag
  reader.cString(16); // schedule_delivery_time
  reader.cString(16); // validity_period
  const registeredDelivery = reader.byte();
  reader.byte(); // replace_if_present_flag
  const dataCoding = reader.byte();
  reader.byte(); // sm_default_msg_id
  const smLength = reader.byte();
  let payload = reader.bytes(smLength);

  let sarReference: number | undefined;
  let sarTotal: number | undefined;
  let sarSequence: number | undefined;
  while (reader.remaining >= 4) {
    const tag = reader.uint16();
    const length = reader.uint16();
    const value = reader.bytes(length);
    if (tag === Tag.messagePayload) payload = value;
    else if (tag === Tag.sarMsgRefNum && length === 2) sarReference = value.readUInt16BE(0);
    else if (tag === Tag.sarTotalSegments && length === 1) sarTotal = value[0];
    else if (tag === Tag.sarSegmentSeqnum && length === 1) sarSequence = value[0];
  }

  let part: ConcatPart | undefined;
  if ((esmClass & 0x40) !== 0) {
    const split = splitUdh(payload);
    payload = split.text;
    part = split.part;
  } else if (sarReference !== undefined && sarTotal !== undefined && sarSequence !== undefined) {
    part = { reference: sarReference, total: sarTotal, sequence: sarSequence };
  }
  if (part !== undefined && (part.total < 1 || part.sequence < 1 || part.sequence > part.total)) {
    throw new SmppProtocolError(Status.invalidMessageLength, 'Неверная нумерация частей');
  }

  return {
    destination,
    esmClass,
    dataCoding,
    registeredDelivery,
    text: decodeText(payload, dataCoding),
    ...(part === undefined ? {} : { part }),
  };
}

/** Заголовок пользовательских данных (UDH): длина, затем элементы «тип, длина, значение». */
function splitUdh(payload: Buffer): { text: Buffer; part?: ConcatPart } {
  const udhLength = payload[0];
  if (udhLength === undefined || udhLength + 1 > payload.length) {
    throw new SmppProtocolError(Status.invalidMessageLength, 'Неверный заголовок частей');
  }
  let part: ConcatPart | undefined;
  let at = 1;
  const end = udhLength + 1;
  while (at + 2 <= end) {
    const type = payload[at];
    const length = payload[at + 1];
    if (type === undefined || length === undefined || at + 2 + length > end) {
      throw new SmppProtocolError(Status.invalidMessageLength, 'Неверный заголовок частей');
    }
    if (type === 0x00 && length === 3) {
      part = {
        reference: payload[at + 2] ?? 0,
        total: payload[at + 3] ?? 0,
        sequence: payload[at + 4] ?? 0,
      };
    } else if (type === 0x08 && length === 4) {
      part = {
        reference: ((payload[at + 2] ?? 0) << 8) | (payload[at + 3] ?? 0),
        total: payload[at + 4] ?? 0,
        sequence: payload[at + 5] ?? 0,
      };
    }
    at += 2 + length;
  }
  return { text: payload.subarray(end), ...(part === undefined ? {} : { part }) };
}

/**
 * Текст по кодировке. 8 — UCS-2 (UTF-16BE); 3 — Latin-1; 0 и 1 — «по умолчанию»: клиенты шлют
 * там то ASCII, то UTF-8, поэтому берётся UTF-8, а если байты им не являются — Latin-1.
 * Двоичные кодировки не принимаются: это не текст.
 */
function decodeText(payload: Buffer, dataCoding: number): string {
  if (dataCoding === 8) return new TextDecoder('utf-16be').decode(payload);
  if (dataCoding === 3) return payload.toString('latin1');
  if (dataCoding === 0 || dataCoding === 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(payload);
    } catch {
      return payload.toString('latin1');
    }
  }
  throw new SmppProtocolError(Status.submitFailed, 'Кодировка сообщения не поддерживается');
}

/** Тело ответа на `bind_*`: имя площадки. */
export const bindResponseBody = (systemId: string): Buffer => cString(systemId);

/** Состояние сообщения в отчёте о доставке (`message_state`, SMPP 3.4, таблица 5-6). */
const MessageState = { delivered: 2, expired: 3, undeliverable: 5, accepted: 6 } as const;

export interface Receipt {
  readonly messageId: string;
  readonly recipient: string;
  readonly submittedAt: Date;
  readonly doneAt: Date;
  readonly state: 'DELIVRD' | 'EXPIRED' | 'UNDELIV' | 'ACCEPTD';
  readonly error: number;
}

/** Дата отчёта в виде ГГММДДччмм (UTC). */
export function receiptDate(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}`;
}

/** Тело `deliver_sm` с отчётом: стандартный текст `id:… stat:…` и признаки для разбора машиной. */
export function encodeReceiptBody(receipt: Receipt): Buffer {
  const text = `id:${receipt.messageId} sub:001 dlvrd:${receipt.state === 'DELIVRD' ? '001' : '000'} submit date:${receiptDate(receipt.submittedAt)} done date:${receiptDate(receipt.doneAt)} stat:${receipt.state} err:${String(receipt.error).padStart(3, '0')} text:`;
  const message = Buffer.from(text, 'latin1');
  const state =
    receipt.state === 'DELIVRD'
      ? MessageState.delivered
      : receipt.state === 'ACCEPTD'
        ? MessageState.accepted
        : receipt.state === 'EXPIRED'
          ? MessageState.expired
          : MessageState.undeliverable;
  return Buffer.concat([
    cString(''), // service_type
    Buffer.from([0x01, 0x01]), // source: международный номер
    cString(receipt.recipient),
    Buffer.from([0x00, 0x00]),
    cString(''), // destination_addr: исходный отправитель мы не храним
    Buffer.from([0x04, 0x00, 0x00]), // esm_class «отчёт», protocol_id, priority_flag
    cString(''),
    cString(''),
    Buffer.from([0x00, 0x00, 0x00, 0x00, message.length]), // registered_delivery, replace, data_coding, default_msg_id, sm_length
    message,
    tlv(Tag.receiptedMessageId, cString(receipt.messageId)),
    tlv(Tag.messageState, Buffer.from([state])),
  ]);
}

function tlv(tag: number, value: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(tag, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value]);
}

export interface SubmitDraft {
  readonly destination: string;
  readonly text: string;
  readonly dataCoding?: number;
  readonly part?: ConcatPart;
}

/**
 * Тело `submit_sm` — нужно проверкам и клиентским инструментам площадки (в самом сервере им никто не
 * пользуется, но без него кодек не проверить на круг). Текст — по `dataCoding` (по умолчанию UCS-2).
 */
export function encodeSubmitBody(draft: SubmitDraft): Buffer {
  const dataCoding = draft.dataCoding ?? 8;
  let text =
    dataCoding === 8
      ? Buffer.from(draft.text, 'utf16le').swap16()
      : Buffer.from(draft.text, 'utf8');
  let esmClass = 0;
  if (draft.part !== undefined) {
    esmClass = 0x40;
    text = Buffer.concat([
      Buffer.from([
        0x05,
        0x00,
        0x03,
        draft.part.reference & 0xff,
        draft.part.total,
        draft.part.sequence,
      ]),
      text,
    ]);
  }
  return Buffer.concat([
    cString(''),
    Buffer.from([0x01, 0x01]),
    cString('zvonix'),
    Buffer.from([0x01, 0x01]),
    cString(draft.destination),
    Buffer.from([esmClass, 0x00, 0x00]),
    cString(''),
    cString(''),
    Buffer.from([0x01, 0x00, dataCoding, 0x00, text.length]),
    text,
  ]);
}

export const bindBody = (systemId: string, password: string): Buffer =>
  Buffer.concat([
    cString(systemId),
    cString(password),
    cString(''),
    Buffer.from([0x34, 0x01, 0x01]),
    cString(''),
  ]);

/** Читает идентификатор из тела ответа (`submit_sm_resp`, `deliver_sm_resp`). */
export function decodeMessageId(body: Buffer): string {
  return body.length === 0 ? '' : new Reader(body).cString(65);
}

/** Тело `deliver_sm` для проверок: разбирает присланный сервером отчёт. */
export function decodeReceiptText(body: Buffer): string {
  const reader = new Reader(body);
  reader.cString(5);
  reader.byte();
  reader.byte();
  reader.cString(20);
  reader.byte();
  reader.byte();
  reader.cString(20);
  reader.byte();
  reader.byte();
  reader.byte();
  reader.cString(16);
  reader.cString(16);
  reader.byte();
  reader.byte();
  reader.byte();
  reader.byte();
  const length = reader.byte();
  return reader.bytes(length).toString('latin1');
}
