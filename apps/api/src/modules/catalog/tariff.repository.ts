/**
 * Запросы к тарифам партнёров и наценке платформы (ADR-0010).
 *
 * Подбор действующей записи устроен одинаково у обеих таблиц: берётся самая свежая
 * из тех, что уже действуют на момент вызова. Записи не редактируются — добавляются
 * новые, поэтому история цен остаётся целой, а прошлые звонки не переоцениваются.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { toDatabaseError, type Database } from '@zvonix/db';
import { commissionRules, partnerRates, priceBands } from '@zvonix/db/schema';
import {
  newId,
  regionKeyOf,
  type BasisPoints,
  type Id,
  type MoneyAmount,
  type Rounding,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type PartnerRateRow = typeof partnerRates.$inferSelect;
export type CommissionRuleRow = typeof commissionRules.$inferSelect;
export type PriceBandRow = typeof priceBands.$inferSelect;

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
        .values({
          id: newId<'partnerRate'>(),
          ...draft,
          // Ключ выводится здесь, а не приходит снаружи: пара «регион без ключа»
          // недостижима при отборе, и забыть его не должно быть возможно.
          regionKey: regionKeyOf(draft.region),
        })
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
   * Регион сравнивается **по приведённому написанию** (ADR-0022, ADR-0023). Сравнение
   * строкой означало бы, что цена, заведённая как `Красноярский кр.`, для вызова
   * в `Красноярский край` не находится и молча подменяется общей ценой партнёра.
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
    const key = regionKeyOf(region);
    const regionMatches =
      key === null
        ? isNull(partnerRates.regionKey)
        : or(isNull(partnerRates.regionKey), eq(partnerRates.regionKey, key));

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
        sql`case when ${partnerRates.regionKey} is null then 1 else 0 end`,
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

  // --- Коридоры цен (ADR-0023) -------------------------------------------------

  async insertPriceBand(draft: {
    operatorId: Id<'operator'>;
    region: string | null;
    minPrice: MoneyAmount;
    maxPrice: MoneyAmount;
    effectiveFrom: Date;
  }): Promise<PriceBandRow> {
    try {
      const [row] = await this.db
        .insert(priceBands)
        .values({ id: newId<'priceBand'>(), ...draft, regionKey: regionKeyOf(draft.region) })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Коридор, действующий по направлению на указанный момент.
   *
   * Старшинство то же, что у цен: коридор с регионом побеждает коридор без него,
   * среди равных — самый свежий из действующих. Момент передаётся явно: цена проверяется
   * коридором **того времени, с которого она начинает действовать**, иначе история цен
   * зависела бы от того, в какой день их ввели.
   */
  async findPriceBand(
    operatorId: Id<'operator'>,
    region: string | null,
    at: Date,
  ): Promise<PriceBandRow | undefined> {
    const key = regionKeyOf(region);
    const regionMatches: SQL | undefined =
      key === null
        ? isNull(priceBands.regionKey)
        : or(isNull(priceBands.regionKey), eq(priceBands.regionKey, key));

    const [row] = await this.db
      .select()
      .from(priceBands)
      .where(
        and(
          eq(priceBands.operatorId, operatorId),
          lte(priceBands.effectiveFrom, at),
          regionMatches,
        ),
      )
      .orderBy(
        sql`case when ${priceBands.regionKey} is null then 1 else 0 end`,
        desc(priceBands.effectiveFrom),
      )
      .limit(1);

    return row;
  }

  async listPriceBands(operatorId?: Id<'operator'>): Promise<PriceBandRow[]> {
    const query = this.db.select().from(priceBands);
    return operatorId === undefined
      ? query.orderBy(desc(priceBands.effectiveFrom))
      : query.where(eq(priceBands.operatorId, operatorId)).orderBy(desc(priceBands.effectiveFrom));
  }

  /**
   * Действующие сейчас коридоры — по одному на направление.
   *
   * `distinct on` вместо выборки всей истории: сравнивать цены с отменёнными коридорами
   * незачем, а история коридоров растёт быстрее, чем их число.
   */
  async listActivePriceBands(at: Date): Promise<PriceBandRow[]> {
    return this.db
      .selectDistinctOn([priceBands.operatorId, priceBands.regionKey])
      .from(priceBands)
      .where(lte(priceBands.effectiveFrom, at))
      .orderBy(
        asc(priceBands.operatorId),
        sql`${priceBands.regionKey} asc nulls last`,
        desc(priceBands.effectiveFrom),
      );
  }

  /** Действующие сейчас цены — по одной на пару «партнёр и направление». */
  async listActivePartnerRates(at: Date): Promise<PartnerRateRow[]> {
    return this.db
      .selectDistinctOn([partnerRates.partnerId, partnerRates.operatorId, partnerRates.regionKey])
      .from(partnerRates)
      .where(lte(partnerRates.effectiveFrom, at))
      .orderBy(
        asc(partnerRates.partnerId),
        asc(partnerRates.operatorId),
        sql`${partnerRates.regionKey} asc nulls last`,
        desc(partnerRates.effectiveFrom),
      );
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
