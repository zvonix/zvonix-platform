/**
 * Конструктор сообщения клиента ([ADR-0087](../../../../../docs/adr/0087-konstruktor-soobshcheniya.md)): шаблон хранится
 * блоками, итоговый текст собирается при отправке одной функцией, общей с предпросмотром в кабинете.
 */

import { Injectable } from '@nestjs/common';
import { composeMessage, type Id, type TemplateBlock, validationFailed } from '@zvonix/shared';
import { BotsService } from './bot/bots.service.js';
import { MessagesRepository } from './messages.repository.js';
import { TemplatesRepository } from './templates.repository.js';

/** Без шаблона — один блок «текст клиента»: сообщение уходит как написано. */
const DEFAULT_TEMPLATE: readonly TemplateBlock[] = [{ kind: 'body', when: 'always' }];

@Injectable()
export class TemplatesService {
  constructor(
    private readonly repository: TemplatesRepository,
    private readonly messages: MessagesRepository,
    private readonly bots: BotsService,
  ) {}

  async get(clientId: Id<'client'>): Promise<readonly TemplateBlock[]> {
    return (await this.repository.find(clientId)) ?? DEFAULT_TEMPLATE;
  }

  /** Форму блоков проверяет схема запроса; здесь — то, что от формы не зависит: ровно один текст клиента. */
  async save(clientId: Id<'client'>, blocks: TemplateBlock[]): Promise<readonly TemplateBlock[]> {
    if (blocks.filter((block) => block.kind === 'body').length !== 1) {
      throw validationFailed('В сообщении должен быть ровно один блок «Текст сообщения»');
    }
    await this.repository.save(clientId, blocks);
    return blocks;
  }

  /**
   * Итоговый текст для отправки. Шаблона нет — исходный, без единого лишнего запроса: так идёт почти весь трафик.
   * «Первое» — до этого этому номеру от этого клиента ничего не ушло.
   */
  async render(message: {
    id: Parameters<MessagesRepository['hasEarlierSent']>[2];
    clientId: Id<'client'>;
    recipient: string;
    text: string;
  }): Promise<string> {
    const blocks = await this.repository.find(message.clientId);
    if (blocks === undefined) return message.text;
    const [first, known] = await Promise.all([
      blocks.some((block) => block.when === 'first' && block.kind !== 'body')
        ? this.messages
            .hasEarlierSent(message.clientId, message.recipient, message.id)
            .then((sent) => !sent)
        : Promise.resolve(false),
      blocks.some((block) => block.kind === 'greeting' || block.kind === 'bot_link')
        ? this.bots.templateContext(message.clientId, message.recipient)
        : Promise.resolve({ name: null, botLink: null }),
    ]);
    return composeMessage(blocks, {
      body: message.text,
      name: known.name,
      botLink: known.botLink,
      first,
    });
  }
}
