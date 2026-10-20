/**
 * Список «не писать» ([ADR-0088](../../../../../docs/adr/0088-otchety-i-zashchita-akkauntov-max.md)).
 */

import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { messageStops } from '@zvonix/db/schema';
import { newId, type MessageStopSource } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

@Injectable()
export class StopsRepository {
  constructor(private readonly database: DatabaseService) {}

  async has(phone: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: messageStops.id })
      .from(messageStops)
      .where(eq(messageStops.phone, phone));
    return row !== undefined;
  }

  /** Номер добавлен впервые — `true`; уже был в списке — `false` (повторный «СТОП» ничего не меняет). */
  async add(phone: string, source: MessageStopSource): Promise<boolean> {
    const rows = await this.database.db
      .insert(messageStops)
      .values({ id: newId<'messageStop'>(), phone, source })
      .onConflictDoNothing({ target: messageStops.phone })
      .returning({ id: messageStops.id });
    return rows.length > 0;
  }
}
