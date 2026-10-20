/**
 * Список «не писать» ([ADR-0088](../../../../../docs/adr/0088-otchety-i-zashchita-akkauntov-max.md)): запрет бывает общим
 * (без клиента) или по клиенту.
 */

import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, isNull, or } from 'drizzle-orm';
import { clients, messageStops } from '@zvonix/db/schema';
import { newId, type Id, type MessageStopSource } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export interface StopRow {
  readonly id: string;
  readonly phone: string;
  readonly source: MessageStopSource;
  readonly clientId: string | null;
  readonly clientName: string | null;
  readonly createdAt: Date;
}

@Injectable()
export class StopsRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Номеру нельзя писать этому клиенту: есть общий запрет или запрет именно этого клиента. */
  async has(phone: string, clientId: Id<'client'>): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: messageStops.id })
      .from(messageStops)
      .where(
        and(
          eq(messageStops.phone, phone),
          or(isNull(messageStops.clientId), eq(messageStops.clientId, clientId)),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Запрет добавлен впервые — `true`; такой уже был (повторный «СТОП») — `false`. */
  async add(
    phone: string,
    source: MessageStopSource,
    clientId: Id<'client'> | null,
  ): Promise<boolean> {
    const rows = await this.database.db
      .insert(messageStops)
      .values({ id: newId<'messageStop'>(), phone, source, clientId })
      .onConflictDoNothing()
      .returning({ id: messageStops.id });
    return rows.length > 0;
  }

  /** Список для сотрудников: новые сверху; `phone` — точное совпадение полного номера (когда человек просит снять запрет). */
  async list(filter: {
    phone?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<{ rows: StopRow[]; total: number }> {
    const where = filter.phone === undefined ? undefined : eq(messageStops.phone, filter.phone);
    const [totalRow] = await this.database.db
      .select({ total: count() })
      .from(messageStops)
      .where(where);
    const rows = await this.database.db
      .select({
        id: messageStops.id,
        phone: messageStops.phone,
        source: messageStops.source,
        clientId: messageStops.clientId,
        clientName: clients.name,
        createdAt: messageStops.createdAt,
      })
      .from(messageStops)
      .leftJoin(clients, eq(clients.id, messageStops.clientId))
      .where(where)
      .orderBy(desc(messageStops.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
    return { rows, total: totalRow?.total ?? 0 };
  }

  /** Убирает запрет; возвращает убранную строку (для журнала) или `undefined`, если такой нет. */
  async remove(id: Id<'messageStop'>): Promise<StopRow | undefined> {
    const [row] = await this.database.db
      .delete(messageStops)
      .where(eq(messageStops.id, id))
      .returning();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      phone: row.phone,
      source: row.source,
      clientId: row.clientId,
      clientName: null,
      createdAt: row.createdAt,
    };
  }
}
