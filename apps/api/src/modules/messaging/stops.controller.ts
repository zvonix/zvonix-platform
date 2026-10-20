/**
 * Список «не писать» для сотрудников ([ADR-0088](../../../../../docs/adr/0088-otchety-i-zashchita-akkauntov-max.md)):
 * посмотреть, кто и чьи сообщения остановил, и по просьбе самого человека убрать запрет.
 */

import { Controller, Delete, Get, HttpCode, Param, Query } from '@nestjs/common';
import { normalizeMsisdn, notFound, parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodQuery } from '../../http/zod.pipe.js';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../identity/identity.service.js';
import { stopsQuerySchema } from './schemas.js';
import { StopsRepository, type StopRow } from './stops.repository.js';

interface StopView {
  readonly id: string;
  /** Номер скрыт: `+7 900 ***-**-67`. Полный номер сотрудник вводит в поиск сам — список его не раскрывает. */
  readonly phone: string;
  readonly source: StopRow['source'];
  /** Чьи сообщения остановлены; пусто — запрет общий, для всех клиентов. */
  readonly client_id: string | null;
  readonly client_name: string | null;
  readonly created_at: string;
}

/** `79001234567` → `+7 900 ***-**-67`: номер — персональные данные (CLAUDE.md), в списке и журнале он скрыт. */
function maskPhone(phone: string): string {
  return phone.length === 11
    ? `+7 ${phone.slice(1, 4)} ***-**-${phone.slice(9)}`
    : `${phone.slice(0, 3)}***`;
}

const toView = (row: StopRow): StopView => ({
  id: row.id,
  phone: maskPhone(row.phone),
  source: row.source,
  client_id: row.clientId,
  client_name: row.clientName,
  created_at: row.createdAt.toISOString(),
});

@Controller()
export class StaffStopsController {
  constructor(
    private readonly stops: StopsRepository,
    private readonly audit: AuditService,
  ) {}

  @Roles('admin', 'support')
  @Get('messages/stops')
  async list(
    @Query(zodQuery(stopsQuerySchema)) query: z.infer<typeof stopsQuerySchema>,
  ): Promise<{ stops: StopView[]; total: number }> {
    const phone = query.phone === undefined ? undefined : normalizeMsisdn(query.phone);
    // Номер ввели, но он не разбирается — такого в списке быть не может.
    if (query.phone !== undefined && phone === undefined) return { stops: [], total: 0 };
    const found = await this.stops.list({ phone, limit: query.limit, offset: query.offset });
    return { total: found.total, stops: found.rows.map(toView) };
  }

  /** Убрать запрет — только по просьбе самого человека; действие остаётся в журнале (номер скрыт). */
  @Roles('admin')
  @Delete('messages/stops/:id')
  @HttpCode(204)
  async remove(@CurrentUser() actor: Principal, @Param('id') id: string): Promise<void> {
    const removed = await this.stops.remove(parseId(id, 'messageStop'));
    if (removed === undefined) throw notFound('Такого запрета нет в списке');
    await this.audit.record({
      action: 'message_stop.removed',
      entityType: 'message_stop',
      entityId: removed.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: {
        phone: maskPhone(removed.phone),
        source: removed.source,
        client_id: removed.clientId,
      },
    });
  }
}
