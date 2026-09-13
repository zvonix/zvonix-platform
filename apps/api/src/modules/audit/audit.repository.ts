/**
 * Чтение журнала действий.
 *
 * Запись живёт в `AuditService` — она идёт рядом с действием и иногда в его транзакции
 * ([ADR-0034](../../../../../docs/adr/0034-zhurnal-deneg-odnoy-tranzakciey.md)).
 * Чтение отдельным классом: у него нет ни одного общего требования с записью, зато
 * есть отбор, страницы и счёт, которых записи знать незачем.
 *
 * Журнал **только читается**. Ни правки, ни удаления здесь нет и не будет: строка,
 * которую можно поправить, перестаёт быть доказательством.
 */

import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { auditLog } from '@zvonix/db/schema';
import type { Id } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type AuditRow = typeof auditLog.$inferSelect;

/**
 * Отбор строк журнала.
 *
 * Поля перечислены не «на всякий случай»: каждое отвечает на свой вопрос разбора.
 * `entityType` с `entityId` — «что происходило с этим объектом», `actorUserId` —
 * «что делал этот человек», `action` — «когда вообще выключали капчу»,
 * `correlationId` — «что ещё случилось в том же запросе».
 */
export interface AuditFilter {
  readonly action?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly actorUserId?: Id<'user'>;
  readonly correlationId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  readonly offset: number;
}

@Injectable()
export class AuditRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(filter: AuditFilter): Promise<{ rows: AuditRow[]; total: number }> {
    const where = condition(filter);

    const rows = await this.database.db
      .select()
      .from(auditLog)
      // По времени события, а не записи: у денежных действий они совпадают,
      // а у отложенных — нет, и разбор идёт по тому, когда произошло.
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
      .where(where)
      .limit(filter.limit)
      .offset(filter.offset);

    const [counted] = await this.database.db.select({ total: count() }).from(auditLog).where(where);

    return { rows, total: counted?.total ?? 0 };
  }

  /**
   * Различные действия, встречающиеся в журнале.
   *
   * Нужны отбору: перечислять их в коде значило бы держать список, который расходится
   * с журналом при каждом новом действии — а имя действия задаёт вызывающий код,
   * и закрытого списка у него нет.
   */
  async actions(): Promise<string[]> {
    const rows = await this.database.db
      .selectDistinct({ action: auditLog.action })
      .from(auditLog)
      .orderBy(auditLog.action);
    return rows.map((row) => row.action);
  }
}

function condition(filter: AuditFilter): SQL | undefined {
  const parts: SQL[] = [];
  if (filter.action !== undefined) parts.push(eq(auditLog.action, filter.action));
  if (filter.entityType !== undefined) parts.push(eq(auditLog.entityType, filter.entityType));
  if (filter.entityId !== undefined) parts.push(eq(auditLog.entityId, filter.entityId));
  if (filter.actorUserId !== undefined) parts.push(eq(auditLog.actorUserId, filter.actorUserId));
  if (filter.correlationId !== undefined) {
    parts.push(eq(auditLog.correlationId, filter.correlationId));
  }
  if (filter.from !== undefined) parts.push(gte(auditLog.occurredAt, filter.from));
  if (filter.to !== undefined) parts.push(lte(auditLog.occurredAt, filter.to));
  return parts.length === 0 ? undefined : and(...parts);
}
