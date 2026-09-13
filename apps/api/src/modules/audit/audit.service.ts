/**
 * Журнал действий.
 *
 * Пишется рядом с действием, а не выводится потом из логов: лог живёт неделями
 * и хранится вне базы, а разбирать спор о списании или о доступе к записи разговора
 * приходится через месяцы.
 *
 * **У записи два режима, и разница между ними — денежная**
 * ([ADR-0034](../../../../../docs/adr/0034-zhurnal-deneg-odnoy-tranzakciey.md)).
 *
 * *Без исполнителя* — отдельной операцией, и неудача только пишется в лог. Это
 * сознательное отступление от [ADR-0003](../../../../../docs/adr/0003-obrabotka-oshibok.md):
 * действие к этому моменту уже совершено и зафиксировано в базе, и отказ из-за
 * неудавшейся записи в журнал вернул бы клиенту ошибку на успешно выполненную операцию.
 *
 * *С исполнителем* — **той же транзакцией**, что и само действие, и неудача записи
 * отменяет действие. Так пишутся денежные действия: «не записалось» обязано означать
 * «не произошло», потому что спор о списании разбирается через месяцы и разбирается
 * по журналу. Глушить ошибку здесь нельзя ещё и технически: PostgreSQL после сбоя
 * в транзакции всё равно откажет во всех следующих запросах до отката.
 */

import { Inject, Injectable } from '@nestjs/common';
import { currentCorrelationId } from '@zvonix/logger';
import { newId, type Id, type UserRole } from '@zvonix/shared';
import { auditLog } from '@zvonix/db/schema';
import type { Executor } from '@zvonix/db';
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

  /**
   * Пишет строку журнала.
   *
   * `executor` — открытая транзакция того действия, которое записывается. С ним запись
   * идёт той же транзакцией и её неудача действие **отменяет**; без него — отдельной
   * операцией, и неудача только попадает в лог.
   */
  async record(event: AuditEvent, executor?: Executor): Promise<void> {
    if (executor !== undefined) {
      await this.insert(event, executor);
      return;
    }

    try {
      await this.insert(event, this.database.db);
    } catch (cause) {
      this.logger.error('Не удалось записать действие в журнал', cause, {
        action: event.action,
        entity_type: event.entityType,
      });
    }
  }

  private async insert(event: AuditEvent, executor: Executor): Promise<void> {
    await executor.insert(auditLog).values({
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
  }
}
