/**
 * Разбор входящего уведомления провайдера: просит ли человек больше не писать
 * ([ADR-0088](../../../../../docs/adr/0088-otchety-i-zashchita-akkauntov-max.md)).
 *
 * Формат (`incomingMessageReceived`: номер — `senderData.chatId` вида `79001234567@c.us`, текст — `textMessageData.textMessage`
 * либо `extendedTextMessageData.text`) взят из документации провайдера и на живом аккаунте MAX ещё не проверен.
 */

import { normalizeMsisdn, type Msisdn } from '@zvonix/shared';

/** Слова, которыми человек просит остановиться: ответ целиком, без регистра и крайних пробелов и знаков. */
const STOP_WORDS: readonly string[] = ['стоп', 'stop', 'отписаться'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Человек написал только «СТОП» (а не фразу, где это слово встретилось). */
export function isStopWord(text: string): boolean {
  const word = text
    .trim()
    .replace(/^[\s.!,"'«»]+|[\s.!,"'«»]+$/gu, '')
    .toLowerCase();
  return STOP_WORDS.includes(word);
}

/** Номер, написавший «СТОП»; `undefined` — это не «СТОП» или номер не разобрать. */
export function stopRequestOf(body: Record<string, unknown>): Msisdn | undefined {
  if (body['typeWebhook'] !== 'incomingMessageReceived') return undefined;
  const data = body['messageData'];
  const sender = body['senderData'];
  if (!isRecord(data) || !isRecord(sender)) return undefined;

  const plain = isRecord(data['textMessageData'])
    ? data['textMessageData']['textMessage']
    : undefined;
  const extended = isRecord(data['extendedTextMessageData'])
    ? data['extendedTextMessageData']['text']
    : undefined;
  const text = typeof plain === 'string' ? plain : extended;
  if (typeof text !== 'string' || !isStopWord(text)) return undefined;

  const chat = sender['chatId'];
  if (typeof chat !== 'string' || !chat.endsWith('@c.us')) return undefined;
  return normalizeMsisdn(chat.slice(0, -'@c.us'.length));
}
