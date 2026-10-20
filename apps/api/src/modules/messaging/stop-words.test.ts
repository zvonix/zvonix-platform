import { describe, expect, it } from 'vitest';
import { isStopWord, stopRequestOf } from './stop-words.js';

const incoming = (text: string, chat = '79001234567@c.us'): Record<string, unknown> => ({
  typeWebhook: 'incomingMessageReceived',
  senderData: { chatId: chat, sender: chat },
  messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
});

describe('«СТОП» во входящем', () => {
  it.each(['СТОП', 'стоп', ' Stop ', 'Отписаться', 'стоп!', '«СТОП»'])(
    '%j — это просьба остановиться',
    (text) => {
      expect(isStopWord(text)).toBe(true);
    },
  );

  it.each(['не стоп', 'остановите, пожалуйста', 'стоп-кран', '', 'спасибо', 'stopped'])(
    '%j — не просьба: слово должно быть ответом целиком',
    (text) => {
      expect(isStopWord(text)).toBe(false);
    },
  );

  it('номер берётся из чата отправителя и приводится к каноническому виду', () => {
    expect(stopRequestOf(incoming('СТОП'))).toBe('79001234567');
    expect(stopRequestOf(incoming('стоп', '89001234567@c.us'))).toBe('79001234567');
  });

  it('текст может прийти как расширенный', () => {
    const body = {
      typeWebhook: 'incomingMessageReceived',
      senderData: { chatId: '79001234567@c.us' },
      messageData: { extendedTextMessageData: { text: 'Стоп' } },
    };
    expect(stopRequestOf(body)).toBe('79001234567');
  });

  it('чужое уведомление, группа, не-текст и мусор — не «СТОП»', () => {
    expect(
      stopRequestOf({ ...incoming('стоп'), typeWebhook: 'outgoingMessageStatus' }),
    ).toBeUndefined();
    expect(stopRequestOf(incoming('стоп', '120363000000000000@g.us'))).toBeUndefined();
    expect(stopRequestOf(incoming('привет'))).toBeUndefined();
    expect(stopRequestOf(incoming('стоп', 'abc@c.us'))).toBeUndefined();
    expect(stopRequestOf({ typeWebhook: 'incomingMessageReceived' })).toBeUndefined();
    expect(
      stopRequestOf({ typeWebhook: 'incomingMessageReceived', senderData: 'x', messageData: 5 }),
    ).toBeUndefined();
  });
});
