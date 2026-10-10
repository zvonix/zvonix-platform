/**
 * Приоритеты партнёров у клиента: хранение ([ADR-0081](../../../../../docs/adr/0081-prioritety-partnyorov-u-klienta.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { toDatabaseError } from '@zvonix/db';
import { clientPartnerPriorities } from '@zvonix/db/schema';
import { newId, type ClientPriorityOffer, type Id } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type ClientPriorityRow = typeof clientPartnerPriorities.$inferSelect;

export interface ClientPriorityEntry {
  readonly partnerId: Id<'partner'>;
  readonly offer: ClientPriorityOffer;
  /** Пусто — «не использовать». */
  readonly priority: number | null;
}

@Injectable()
export class PrioritiesRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(
    clientId: Id<'client'>,
    offers: readonly ClientPriorityOffer[],
  ): Promise<ClientPriorityRow[]> {
    return this.database.db
      .select()
      .from(clientPartnerPriorities)
      .where(
        and(
          eq(clientPartnerPriorities.clientId, clientId),
          inArray(clientPartnerPriorities.offer, [...offers]),
        ),
      )
      .orderBy(asc(clientPartnerPriorities.priority), asc(clientPartnerPriorities.createdAt));
  }

  /**
   * Заменяет список клиента по этим предложениям целиком одной транзакцией: список — это порядок, и менять его
   * частями значит на время оставить клиента с порядком, которого он не задавал. Отметки очереди переживают замену.
   */
  async replace(
    clientId: Id<'client'>,
    offers: readonly ClientPriorityOffer[],
    entries: readonly ClientPriorityEntry[],
  ): Promise<void> {
    const scope = and(
      eq(clientPartnerPriorities.clientId, clientId),
      inArray(clientPartnerPriorities.offer, [...offers]),
    );
    try {
      await this.database.db.transaction(async (tx) => {
        const kept = await tx.select().from(clientPartnerPriorities).where(scope);
        const routed = new Map(
          kept.map((row) => [`${row.partnerId}:${row.offer}`, row.lastRoutedAt]),
        );
        await tx.delete(clientPartnerPriorities).where(scope);
        if (entries.length === 0) return;
        await tx.insert(clientPartnerPriorities).values(
          entries.map((entry) => ({
            id: newId<'clientPartnerPriority'>(),
            clientId,
            partnerId: entry.partnerId,
            offer: entry.offer,
            priority: entry.priority,
            lastRoutedAt: routed.get(`${entry.partnerId}:${entry.offer}`) ?? null,
          })),
        );
      });
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }
}
