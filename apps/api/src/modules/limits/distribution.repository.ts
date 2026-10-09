/**
 * Распределение партнёра: хранение ([ADR-0080](../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)).
 * Одна таблица на звонки и сообщения MAX; направление — поле `product`.
 */

import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { toDatabaseError } from '@zvonix/db';
import { partnerDistributions } from '@zvonix/db/schema';
import { newId, type DistributionProduct, type Id } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type DistributionRow = typeof partnerDistributions.$inferSelect;
export type DistributionValues = Omit<
  DistributionRow,
  'id' | 'partnerId' | 'product' | 'createdAt' | 'updatedAt'
>;

@Injectable()
export class DistributionRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Настройки партнёров для направления; у кого записи нет — тех в результате нет. */
  async forPartners(
    partnerIds: readonly Id<'partner'>[],
    product: DistributionProduct,
  ): Promise<Map<string, DistributionRow>> {
    const result = new Map<string, DistributionRow>();
    if (partnerIds.length === 0) return result;
    const rows = await this.database.db
      .select()
      .from(partnerDistributions)
      .where(
        and(
          inArray(partnerDistributions.partnerId, [...partnerIds]),
          eq(partnerDistributions.product, product),
        ),
      );
    for (const row of rows) result.set(row.partnerId, row);
    return result;
  }

  async upsert(
    partnerId: Id<'partner'>,
    product: DistributionProduct,
    values: DistributionValues,
  ): Promise<DistributionRow> {
    try {
      const [row] = await this.database.db
        .insert(partnerDistributions)
        .values({ id: newId<'partnerDistribution'>(), partnerId, product, ...values })
        .onConflictDoUpdate({
          target: [partnerDistributions.partnerId, partnerDistributions.product],
          set: { ...values, updatedAt: new Date() },
        })
        .returning();
      if (row === undefined) throw new Error('Настройки распределения не записаны');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }
}
