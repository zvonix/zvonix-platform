/**
 * Запросы к тарифам партнёров и наценке платформы (ADR-0010).
 *
 * Подбор действующей записи устроен одинаково у обеих таблиц: берётся самая свежая
 * из тех, что уже действуют на момент вызова. Записи не редактируются — добавляются
 * новые, поэтому история цен остаётся целой, а прошлые звонки не переоцениваются.
 */

import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { toDatabaseError, type Database } from '@zvonix/db';
import { commissionRules, partnerRates } from '@zvonix/db/schema';
import { newId, type BasisPoints, type Id, type MoneyAmount, type Rounding } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type PartnerRateRow = typeof partnerRates.$inferSelect;
export type CommissionRuleRow = typeof commissionRules.$inferSelect;

@Injectable()
export class TariffRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db(): Database {
    return this.database.db;
  }

  async insertPartnerRate(draft: {
    partnerId: Id<'partner'>;
    operatorId: Id<'operator'>;
    region: string | null;
    pricePerMinute: MoneyAmount;
    billingIncrementSeconds: number;
    minimumDurationSeconds: number;
    connectionFee: MoneyAmount;
    rounding: Rounding;
    effectiveFrom: Date;
  }): Promise<PartnerRateRow> {
    try {
      const [row] = await this.db
        .insert(partnerRates)
        .values({ id: newId<'partnerRate'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Действующий тариф партнёра по направлению.
   *
   * Запись с указанным регионом побеждает запись без него: частный случай уточняет общий,
   * а не спорит с ним. Отсюда сортировка — сначала по наличию региона, потом по свежести.
   *
   * Порядок именно такой, а не «свежесть, потом регион»: иначе новая общая цена вытеснила бы
   * действующую региональную, и партнёр, поднявший цену по стране, молча потерял бы
   * договорённость по конкретному региону.
   */
  async findPartnerRate(
    partnerId: Id<'partner'>,
    operatorId: Id<'operator'>,
    region: string | null,
    at: Date,
  ): Promise<PartnerRateRow | undefined> {
    const regionMatches =
      region === null
        ? isNull(partnerRates.region)
        : or(isNull(partnerRates.region), eq(partnerRates.region, region));

    const [row] = await this.db
      .select()
      .from(partnerRates)
      .where(
        and(
          eq(partnerRates.partnerId, partnerId),
          eq(partnerRates.operatorId, operatorId),
          lte(partnerRates.effectiveFrom, at),
          regionMatches,
        ),
      )
      .orderBy(
        sql`case when ${partnerRates.region} is null then 1 else 0 end`,
        desc(partnerRates.effectiveFrom),
      )
      .limit(1);

    return row;
  }

  async listPartnerRates(partnerId: Id<'partner'>): Promise<PartnerRateRow[]> {
    return this.db
      .select()
      .from(partnerRates)
      .where(eq(partnerRates.partnerId, partnerId))
      .orderBy(desc(partnerRates.effectiveFrom));
  }

  async insertCommissionRule(draft: {
    clientId: Id<'client'> | null;
    fixedFee: MoneyAmount;
    percentBasisPoints: BasisPoints;
    effectiveFrom: Date;
  }): Promise<CommissionRuleRow> {
    try {
      const [row] = await this.db
        .insert(commissionRules)
        .values({ id: newId<'commissionRule'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Действующая наценка: правило клиента, если оно есть, иначе правило платформы.
   *
   * Тот же порядок, что у тарифов: сначала частный случай, потом свежесть. Новое общее
   * правило не должно отменять индивидуальную договорённость с клиентом.
   */
  async findCommissionRule(
    clientId: Id<'client'>,
    at: Date,
  ): Promise<CommissionRuleRow | undefined> {
    const [row] = await this.db
      .select()
      .from(commissionRules)
      .where(
        and(
          lte(commissionRules.effectiveFrom, at),
          or(isNull(commissionRules.clientId), eq(commissionRules.clientId, clientId)),
        ),
      )
      .orderBy(
        sql`case when ${commissionRules.clientId} is null then 1 else 0 end`,
        desc(commissionRules.effectiveFrom),
      )
      .limit(1);

    return row;
  }

  async listCommissionRules(): Promise<CommissionRuleRow[]> {
    return this.db.select().from(commissionRules).orderBy(desc(commissionRules.effectiveFrom));
  }
}
