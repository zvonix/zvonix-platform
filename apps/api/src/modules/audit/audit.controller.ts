/**
 * Чтение журнала действий.
 *
 * До этого обработчика журнал писался, но прочитать его можно было только запросом
 * к базе. Журнал, к которому нет доступа, не выполняет своей задачи: смысл записи
 * «кто изменил коридор цен» ровно в том, что через месяцы кто-то придёт и посмотрит.
 *
 * **Только чтение.** Ни правки, ни удаления в API нет и не будет.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { parseId, type UserRole } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { zodQuery } from '../../http/zod.pipe.js';
import { IdentityService } from '../identity/identity.service.js';
import type { UserId } from '../identity/identity.repository.js';
import { AuditRepository, type AuditRow } from './audit.repository.js';
import { auditQuerySchema } from './schemas.js';

/**
 * Строка журнала по проводу.
 *
 * `actor` разворачивается в человека: в базе лежит идентификатор, а разбирать журнал
 * по идентификаторам невозможно. Пусто у действий системы — истечение резерва,
 * автоотключение SIM по порогу неудач: у них нет инициатора, и это тоже факт.
 */
interface AuditEntryView {
  readonly id: string;
  readonly occurred_at: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly actor: { id: string; email: string; full_name: string } | null;
  /** Роль на момент действия, копией из журнала: сегодняшняя роль может быть другой. */
  readonly actor_role: UserRole | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly ip: string | null;
  readonly correlation_id: string | null;
}

@Controller()
export class AuditController {
  constructor(
    private readonly repository: AuditRepository,
    private readonly identity: IdentityService,
  ) {}

  /**
   * Строки журнала по отбору.
   *
   * Поддержке доступен наравне с администратором: разбор обращения начинается
   * с вопроса «что вообще происходило с этим объектом».
   */
  @Roles('admin', 'support')
  @Get('audit')
  async list(
    @Query(zodQuery(auditQuerySchema)) query: z.infer<typeof auditQuerySchema>,
  ): Promise<{ entries: AuditEntryView[]; total: number }> {
    const found = await this.repository.list({
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...(query.actorUserId === undefined
        ? {}
        : { actorUserId: parseId(query.actorUserId, 'user') }),
      ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
      ...(query.from === undefined ? {} : { from: new Date(query.from) }),
      ...(query.to === undefined ? {} : { to: new Date(query.to) }),
      limit: query.limit,
      offset: query.offset,
    });

    // Имена разрешаются одним запросом на страницу, а не по строке: страница
    // в двести строк дала бы двести запросов там, где хватает одного.
    const actorIds = [
      ...new Set(
        found.rows.map((row) => row.actorUserId).filter((id): id is UserId => id !== null),
      ),
    ];
    const names = await this.identity.namesOf(actorIds);

    return {
      total: found.total,
      entries: found.rows.map((row) => toView(row, names)),
    };
  }

  /**
   * Какие действия вообще встречаются в журнале — для отбора.
   *
   * Спрашивается у журнала, а не перечисляется в коде: имя действия задаёт вызывающий
   * код, закрытого списка у него нет, и всякий список в интерфейсе разошёлся бы
   * с содержимым на первом же новом действии.
   */
  @Roles('admin', 'support')
  @Get('audit/actions')
  async actions(): Promise<{ actions: string[] }> {
    return { actions: await this.repository.actions() };
  }
}

function toView(
  row: AuditRow,
  names: Map<string, { email: string; fullName: string }>,
): AuditEntryView {
  const actor = row.actorUserId === null ? undefined : names.get(row.actorUserId);

  return {
    id: row.id,
    occurred_at: row.occurredAt.toISOString(),
    action: row.action,
    entity_type: row.entityType,
    entity_id: row.entityId,
    actor:
      row.actorUserId === null
        ? null
        : {
            id: row.actorUserId,
            // Учётную запись могли закрыть, а строка журнала остаётся: ссылка на неё
            // проставлена как `on delete set null`, но между удалением и чтением
            // возможен и просто ненайденный идентификатор. Прочерк честнее пустоты.
            email: actor?.email ?? '—',
            full_name: actor?.fullName ?? 'запись удалена',
          },
    actor_role: row.actorRole as UserRole | null,
    before: row.before,
    after: row.after,
    ip: row.ip,
    correlation_id: row.correlationId,
  };
}
