/**
 * Список «не писать» ([ADR-0088](../../../../../docs/adr/0088-otchety-i-zashchita-akkauntov-max.md)): ответ «СТОП» на аккаунт
 * партнёра или боту закрывает номер для всех клиентов и всех путей. Хранится только номер и время.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { MessageStopSource } from '@zvonix/shared';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { stopRequestOf } from './stop-words.js';
import { StopsRepository } from './stops.repository.js';

@Injectable()
export class StopsService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: StopsRepository,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('stops');
  }

  isStopped(phone: string): Promise<boolean> {
    return this.repository.has(phone);
  }

  /** Номер просит не писать: заносится в список; повтор ничего не меняет. */
  async stop(phone: string, source: MessageStopSource): Promise<void> {
    if (await this.repository.add(phone, source)) {
      this.logger.info('Номер добавлен в список «не писать»', { source });
    }
  }

  /** Входящее уведомление провайдера: «СТОП» — в список, всё прочее игнорируется (текст ответов не читается и не хранится). */
  async handleIncoming(body: Record<string, unknown>): Promise<void> {
    const phone = stopRequestOf(body);
    if (phone !== undefined) await this.stop(phone, 'account');
  }
}
