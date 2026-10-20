/**
 * Список «не писать» ([ADR-0088](../../../../../docs/adr/0088-otchety-i-zashchita-akkauntov-max.md)): ответ «СТОП» на аккаунт
 * партнёра или боту закрывает номер для всех клиентов и всех путей. Хранится только номер и время.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Id, MessageStopSource } from '@zvonix/shared';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { stopRequestOf } from './stop-words.js';
import { MessagesRepository } from './messages.repository.js';
import { StopsRepository } from './stops.repository.js';

/** Кому отвечал человек: последнее сообщение ему с этого аккаунта должно быть не старше этого срока. */
const REPLY_WINDOW_MS = 3 * 86_400_000;

@Injectable()
export class StopsService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: StopsRepository,
    private readonly messages: MessagesRepository,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('stops');
  }

  isStopped(phone: string, clientId: Id<'client'>): Promise<boolean> {
    return this.repository.has(phone, clientId);
  }

  /** Номер просит не писать: заносится в список; повтор ничего не меняет. */
  async stop(
    phone: string,
    source: MessageStopSource,
    clientId: Id<'client'> | null,
  ): Promise<void> {
    if (await this.repository.add(phone, source, clientId)) {
      this.logger.info('Номер добавлен в список «не писать»', {
        source,
        scope: clientId === null ? 'all' : 'client',
      });
    }
  }

  /**
   * Входящее уведомление провайдера: «СТОП» — в список, всё прочее игнорируется (текст ответов не читается и не хранится).
   * Запрет ставится тому клиенту, чьё сообщение человек получил с этого аккаунта последним (не старше трёх суток);
   * не нашли — запрет общий: безопаснее остановить всех, чем продолжить писать человеку, который просил не писать.
   */
  async handleIncoming(body: Record<string, unknown>, instanceId: string): Promise<void> {
    const phone = stopRequestOf(body);
    if (phone === undefined) return;
    const clientId = await this.messages.lastClientSentTo(
      instanceId,
      phone,
      new Date(Date.now() - REPLY_WINDOW_MS),
    );
    await this.stop(phone, 'account', clientId ?? null);
  }
}
