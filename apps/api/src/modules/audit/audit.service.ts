/**
 * Журнал действий.
 *
 * Пишется рядом с действием, а не выводится потом из логов: лог живёт неделями
 * и хранится вне базы, а разбирать спор о списании или о доступе к записи разговора
 * приходится через месяцы.
 *
 * **Сознательное отступление от ADR-0003**, который запрещает `catch`, только пишущий в лог
 * и продолжающий работу. Здесь оно оправдано: действие к этому моменту уже совершено
 * и зафиксировано в базе, и отказ из-за неудавшейся записи в журнал вернул бы клиенту
 * ошибку на успешно выполненную операцию. Ошибка при этом не проглатывается — она уходит
 * в лог уровнем `error`.
 *
 * Правильное решение для денежных действий — писать проводку и строку журнала одной
 * транзакцией: тогда «не записалось» означает «не произошло». Это требует протаскивания
 * транзакции через репозитории и делается на этапе 1 вместе с журналом проводок
 * ([ADR-0010](../../../../../docs/adr/0010-model-billinga.md)); строка есть в TASKS.md.
 */

import { Inject, Injectable } from '@nestjs/common';
import { currentCorrelationId } from '@zvonix/logger';
import { newId, type Id, type UserRole } from '@zvonix/shared';
import { auditLog } from '@zvonix/db/schema';
import { DatabaseService } from '../../infra/database.service.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';

export interface AuditEvent {
  /** Что сделано: `user.registered`, `session.created`, `recording.downloaded`. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string;
  readonly actorUserId?: Id<'user'> | null;
  readonly actorRole?: UserRole | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger: Logger;

  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('audit');
  }

  async record(event: AuditEvent): Promise<void> {
    try {
      await this.database.db.insert(auditLog).values({
        id: newId<'audit'>(),
        actorUserId: event.actorUserId ?? null,
        actorRole: event.actorRole ?? null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        before: event.before ?? null,
        after: event.after ?? null,
        ip: event.ip ?? null,
        userAgent: event.userAgent ?? null,
        correlationId: currentCorrelationId() ?? null,
        occurredAt: new Date(),
      });
    } catch (cause) {
      this.logger.error('Не удалось записать действие в журнал', cause, {
        action: event.action,
        entity_type: event.entityType,
      });
    }
  }
}
