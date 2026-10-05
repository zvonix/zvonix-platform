import { describe, expect, it } from 'vitest';
import {
  bindBody,
  decodeBind,
  decodeMessageId,
  decodeReceiptText,
  decodeSubmit,
  encodePdu,
  encodeReceiptBody,
  encodeResponse,
  encodeSubmitBody,
  PduFramer,
  receiptDate,
  SmppProtocolError,
  Command,
  Status,
} from './codec.js';

const pduOf = (body: Buffer, sequence = 7): Buffer =>
  encodePdu(Command.submitSm, Status.ok, sequence, body);

describe('разбор потока PDU', () => {
  it('собирает PDU из кусков и разделяет склеенные', () => {
    const first = pduOf(encodeSubmitBody({ destination: '79001234567', text: 'один' }), 1);
    const second = pduOf(encodeSubmitBody({ destination: '79001234567', text: 'два' }), 2);
    const stream = Buffer.concat([first, second]);

    const framer = new PduFramer();
    expect(framer.push(stream.subarray(0, 10))).toHaveLength(0);
    const parsed = [
      ...framer.push(stream.subarray(10, first.length + 5)),
      ...framer.push(stream.subarray(first.length + 5)),
    ];
    expect(parsed.map((pdu) => pdu.sequence)).toEqual([1, 2]);
  });

  it('длина короче заголовка и длиннее предела — ошибка протокола', () => {
    const tooShort = Buffer.alloc(16);
    tooShort.writeUInt32BE(8, 0);
    expect(() => new PduFramer().push(tooShort)).toThrow(SmppProtocolError);

    const tooLong = Buffer.alloc(16);
    tooLong.writeUInt32BE(10_000_000, 0);
    expect(() => new PduFramer().push(tooLong)).toThrow(SmppProtocolError);
  });
});

describe('вход', () => {
  it('имя и пароль читаются', () => {
    expect(decodeBind(bindBody('zxabc12345', 'secretSecret1234'))).toEqual({
      systemId: 'zxabc12345',
      password: 'secretSecret1234',
    });
  });

  it('имя длиннее 16 знаков — ошибка, а не молчаливая обрезка', () => {
    expect(() => decodeBind(bindBody('a'.repeat(17), 'x'))).toThrow(SmppProtocolError);
  });

  it('оборванное тело — ошибка протокола, а не исключение чтения', () => {
    expect(() => decodeBind(Buffer.from('abc', 'latin1'))).toThrow(SmppProtocolError);
  });
});

describe('текст сообщения', () => {
  it('UCS-2: кириллица и эмодзи (суррогатная пара)', () => {
    const decoded = decodeSubmit(
      encodeSubmitBody({ destination: '79001234567', text: 'Привет 😀', dataCoding: 8 }),
    );
    expect(decoded.text).toBe('Привет 😀');
    expect(decoded.destination).toBe('79001234567');
  });

  it('кодировка 0: UTF-8, если байты ею являются, иначе Latin-1', () => {
    expect(
      decodeSubmit(encodeSubmitBody({ destination: '7', text: 'Привет', dataCoding: 0 })).text,
    ).toBe('Привет');

    const body = encodeSubmitBody({ destination: '7', text: 'x', dataCoding: 0 });
    body[body.length - 1] = 0xe9; // единственный байт «é» в Latin-1 — не UTF-8
    expect(decodeSubmit(body).text).toBe('é');
  });

  it('двоичная кодировка не принимается', () => {
    expect(() =>
      decodeSubmit(encodeSubmitBody({ destination: '7', text: 'x', dataCoding: 4 })),
    ).toThrow(SmppProtocolError);
  });

  it('части длинного текста: заголовок UDH снимается, номер части читается', () => {
    const decoded = decodeSubmit(
      encodeSubmitBody({
        destination: '79001234567',
        text: 'начало',
        part: { reference: 9, total: 2, sequence: 1 },
      }),
    );
    expect(decoded.text).toBe('начало');
    expect(decoded.part).toEqual({ reference: 9, total: 2, sequence: 1 });
  });

  it('номер части больше общего числа — ошибка', () => {
    expect(() =>
      decodeSubmit(
        encodeSubmitBody({
          destination: '7',
          text: 'x',
          part: { reference: 1, total: 2, sequence: 3 },
        }),
      ),
    ).toThrow(SmppProtocolError);
  });

  it('обрезанное сообщение — ошибка протокола', () => {
    const body = encodeSubmitBody({ destination: '79001234567', text: 'hello', dataCoding: 3 });
    expect(() => decodeSubmit(body.subarray(0, body.length - 3))).toThrow(SmppProtocolError);
  });
});

describe('отчёт о доставке', () => {
  it('в тексте — идентификатор, состояние и дата, которые читают стандартные клиенты', () => {
    const body = encodeReceiptBody({
      messageId: 'abc-123',
      recipient: '79001234567',
      submittedAt: new Date(Date.UTC(2026, 9, 5, 12, 30)),
      doneAt: new Date(Date.UTC(2026, 9, 5, 12, 31)),
      state: 'UNDELIV',
      error: 1,
    });
    const text = decodeReceiptText(body);
    expect(text).toContain('id:abc-123');
    expect(text).toContain('stat:UNDELIV');
    expect(text).toContain('err:001');
    expect(text).toContain('submit date:2610051230');
    expect(text).toContain('done date:2610051231');
  });

  it('дата — ГГММДДччмм по UTC', () => {
    expect(receiptDate(new Date(Date.UTC(2027, 0, 2, 3, 4)))).toBe('2701020304');
  });
});

describe('ответ', () => {
  it('код ответа — код запроса со старшим битом; идентификатор читается из тела', () => {
    const response = encodeResponse(
      Command.submitSm,
      Status.ok,
      5,
      Buffer.from('id-1\0', 'latin1'),
    );
    const [pdu] = new PduFramer().push(response);
    expect(pdu?.commandId).toBe(0x80000004);
    expect(pdu?.sequence).toBe(5);
    expect(decodeMessageId(pdu?.body ?? Buffer.alloc(0))).toBe('id-1');
  });
});
