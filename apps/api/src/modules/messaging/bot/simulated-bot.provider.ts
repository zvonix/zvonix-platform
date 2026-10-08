/**
 * Имитация API ботов MAX: без внешних вызовов, для разработки и проверок
 * ([ADR-0077](../../../../../../docs/adr/0077-bot-max-vtoroy-kanal.md)). Токен вида `ok-<имя>` — рабочий бот
 * с никнеймом `<имя>_bot`; любой другой отвергается. Чат на `0000` «остановил бота».
 */

import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  BotRecipientRejectedError,
  BotTokenRejectedError,
  type BotIdentity,
  type BotProvider,
} from './bot.provider.js';

/** Что «отправил» бот: проверки читают отсюда. */
export const simulatedBotSent: {
  token: string;
  chatId: string;
  text: string;
  requestContact: string | undefined;
}[] = [];

/** Адреса, на которые бот «подписан»: токен → адрес и секрет. */
export const simulatedBotSubscriptions = new Map<string, { url: string; secret: string }>();

@Injectable()
export class SimulatedBotProvider implements BotProvider {
  me(token: string): Promise<BotIdentity> {
    const match = /^ok-([a-z0-9]+)$/u.exec(token);
    if (match?.[1] === undefined) return Promise.reject(new BotTokenRejectedError('токен негоден'));
    return Promise.resolve({
      userId: `100${String(match[1].length)}`,
      name: `Бот ${match[1]}`,
      username: `${match[1]}_bot`,
    });
  }

  subscribe(token: string, url: string, secret: string): Promise<void> {
    simulatedBotSubscriptions.set(token, { url, secret });
    return Promise.resolve();
  }

  unsubscribe(token: string): Promise<void> {
    simulatedBotSubscriptions.delete(token);
    return Promise.resolve();
  }

  send(
    token: string,
    chatId: string,
    text: string,
    options?: { readonly requestContact?: string },
  ): Promise<{ messageId: string }> {
    if (/0000$/u.test(chatId)) {
      return Promise.reject(new BotRecipientRejectedError('остановил бота'));
    }
    simulatedBotSent.push({ token, chatId, text, requestContact: options?.requestContact });
    return Promise.resolve({ messageId: `sim-bot-${randomUUID().slice(0, 10)}` });
  }
}
