/**
 * Запросы к тарифам партнёров и наценке платформы (ADR-0010).
 *
 * Подбор действующей записи устроен одинаково у обеих таблиц: берётся самая свежая
 * из тех, что уже действуют на момент вызова. Записи не редактируются — добавляются
 * новые, поэтому история цен остаётся целой, а прошлые звонки не переоцениваются.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { toDatabaseError, type Database, type Executor } from '@zvonix/db';
import { commissionRules, partnerRates, priceBands } from '@zvonix/db/schema';
import {
  newId,
  regionKeyOf,
  regionKeysOf,
  type BasisPoints,
  type Id,
  type MoneyAmount,
  type Rounding,
  type TerminationKind,
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

  /** Пул: нужен службе, чтобы открыть транзакцию вокруг записи цены и её журнала. */
  get pool(): Database {
    return this.database.db;
  }

  async insertPartnerRate(
    draft: {
      partnerId: Id<'partner'>;
      operatorId: Id<'operator'>;
      terminationKind: TerminationKind;
      region: string | null;
      pricePerMinute: MoneyAmount;
      billingIncrementSeconds: number;
      minimumDurationSeconds: number;
      connectionFee: MoneyAmount;
      rounding: Rounding;
      effectiveFrom: Date;
    },
    executor: Executor = this.db,
  ): Promise<PartnerRateRow> {
    try {
      const [row] = await executor
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
   * Регион сравнивается **по набору приведённых написаний** (ADR-0022, ADR-0023,
   * [ADR-0033](../../../../../docs/adr/0033-region-eto-mnozhestvo.md)). Сравнение строкой
   * означало бы, что цена, заведённая как `Красноярский кр.`, для вызова в `Красноярский
   * край` не находится и молча подменяется общей ценой партнёра. Набор, а не один ключ,
   * потому что диапазон бывает выделен на два субъекта сразу: `Город Москва, Московская
   * область`. Подошли обе региональные цены — берётся самая свежая, по общему правилу
   * старшинства ниже.
   *
   * Порядок именно такой, а не «свежесть, потом регион»: иначе новая общая цена вытеснила бы
   * действующую региональную, и партнёр, поднявший цену по стране, молча потерял бы
   * договорённость по конкретному региону.
   */
  async findPartnerRate(
    partnerId: Id<'partner'>,
    operatorId: Id<'operator'>,
    terminationKind: TerminationKind,
    region: string | null,
    at: Date,
  ): Promise<PartnerRateRow | undefined> {
    const keys = regionKeysOf(region);
    const regionMatches =
      keys.length === 0
        ? isNull(partnerRates.regionKey)
        : or(isNull(partnerRates.regionKey), inArray(partnerRates.regionKey, keys));

    const [row] = await this.db
      .select()
      .from(partnerRates)
      .where(
        and(
          eq(partnerRates.partnerId, partnerId),
          eq(partnerRates.operatorId, operatorId),
          eq(partnerRates.terminationKind, terminationKind),
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

  /**
   * Действующие цены сразу нескольких партнёров по одному направлению.
   *
   * Нужна отбору кандидатов: порядок терминации зависит от цены
   * ([ADR-0040](../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)),
   * а спрашивать цену по одному кандидату — это запрос на каждого из них в горячем пути.
   *
   * `distinct on` берёт по одной строке на партнёра тем же правилом отбора, что
   * и `findPartnerRate`: запись с указанным регионом побеждает запись без него,
   * среди равных — самая свежая. Правило одно, потому что расхождение здесь означало бы,
   * что вызов уходит по одной цене, а тарифицируется по другой.
   */
  async findEffectiveRates(
    partnerIds: readonly Id<'partner'>[],
    operatorId: Id<'operator'>,
    terminationKind: TerminationKind,
    region: string | null,
    at: Date,
  ): Promise<Map<string, PartnerRateRow>> {
    if (partnerIds.length === 0) return new Map();

    const keys = regionKeysOf(region);
    const regionMatches =
      keys.length === 0
        ? sql`region_key is null`
        : sql`(region_key is null or region_key in (${values(keys)}))`;

    const result = await this.db.execute(sql`
      select distinct on (partner_id) *
        from partner_rates
       where partner_id in (${values(partnerIds)})
         and operator_id = ${operatorId}
         and termination_kind = ${terminationKind}
         and effective_from <= ${at}
         and ${regionMatches}
       order by partner_id,
                case when region_key is null then 1 else 0 end,
                effective_from desc
    `);

    return new Map(result.rows.map((row) => [String(row['partner_id']), toPartnerRate(row)]));
  }

  /**
   * Все действующие цены названных партнёров — по одной на направление.
   *
   * Нужна прайсу клиента: он показывает диапазон по каждому предложению, а диапазон
   * складывается из всех направлений сразу
   * ([ADR-0040](../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)).
   *
   * Правило отбора то же, что у одиночного поиска: по одной строке на сочетание
   * «партнёр — способ — оператор — регион», самая свежая из действующих. Это **экран
   * кабинета, а не горячий путь**: строк здесь столько, сколько направлений завели
   * партнёры, и разбивать их на страницы понадобится не раньше, чем прайс перестанет
   * помещаться на экран.
   */
  async listEffectiveRates(
    partnerIds: readonly Id<'partner'>[],
    operatorId: Id<'operator'> | undefined,
    at: Date,
  ): Promise<PartnerRateRow[]> {
    if (partnerIds.length === 0) return [];

    const byOperator = operatorId === undefined ? sql`true` : sql`operator_id = ${operatorId}`;

    const result = await this.db.execute(sql`
      select distinct on (partner_id, termination_kind, operator_id, region_key) *
        from partner_rates
       where partner_id in (${values(partnerIds)})
         and effective_from <= ${at}
         and ${byOperator}
       order by partner_id, termination_kind, operator_id, region_key, effective_from desc
    `);

    return result.rows.map(toPartnerRate);
  }

  async listPartnerRates(partnerId: Id<'partner'>): Promise<PartnerRateRow[]> {
    return this.db
      .select()
      .from(partnerRates)
      .where(eq(partnerRates.partnerId, partnerId))
      .orderBy(desc(partnerRates.effectiveFrom));
  }

  // --- Коридоры цен (ADR-0023) -------------------------------------------------

  async insertPriceBand(
    draft: {
      operatorId: Id<'operator'>;
      region: string | null;
      minPrice: MoneyAmount;
      maxPrice: MoneyAmount;
      effectiveFrom: Date;
    },
    executor: Executor = this.db,
  ): Promise<PriceBandRow> {
    try {
      const [row] = await executor
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
   * среди равных — самый свежий из действующих. Регион сравнивается набором ключей
   * ([ADR-0033](../../../../../docs/adr/0033-region-eto-mnozhestvo.md)). Момент передаётся явно: цена проверяется
   * коридором **того времени, с которого она начинает действовать**, иначе история цен
   * зависела бы от того, в какой день их ввели.
   */
  async findPriceBand(
    operatorId: Id<'operator'>,
    region: string | null,
    at: Date,
    executor: Executor = this.db,
  ): Promise<PriceBandRow | undefined> {
    const keys = regionKeysOf(region);
    const regionMatches: SQL | undefined =
      keys.length === 0
        ? isNull(priceBands.regionKey)
        : or(isNull(priceBands.regionKey), inArray(priceBands.regionKey, keys));

    const [row] = await executor
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

  /**
   * Запирает направления оператора до конца транзакции.
   *
   * Коридор проверяется при записи цены, а сам он тоже строка, которую кто-то
   * в этот момент добавляет ([ADR-0023](../../../../../docs/adr/0023-koridory-cen.md)).
   * Без запирания между проверкой и вставкой коридор успевает сузиться, и цена
   * оказывается снаружи ограничения, которое её только что пропустило.
   *
   * Запирается **оператор целиком**, а не пара «оператор и регион»: общий коридор
   * ограничивает и региональную цену, поэтому запирание по паре не свело бы их
   * в одну очередь. Записи цен и коридоров редки — административное действие,
   * а теперь ещё и партнёрское, — и последовательность по оператору ничего не стоит.
   *
   * Блокировка транзакционная: снимается сама, в том числе при откате. Ключ
   * с префиксом, чтобы не столкнуться с чужой блокировкой по тому же идентификатору.
   */
  async lockOperatorTariffs(operatorId: Id<'operator'>, executor: Executor): Promise<void> {
    await executor.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tariff:${operatorId}`}, 0))`,
    );
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

  /**
   * Действующие сейчас цены — по одной на пару «партнёр и направление».
   *
   * Способ терминации входит в направление ([ADR-0040](../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)):
   * у партнёра с SIM и транком по одному оператору **две** цены, и без него одна
   * из двух молча исчезала бы из выборки. Для разбора нарушений коридора это значило
   * бы, что цена транка не проверяется вовсе, — а коридор и есть единственное
   * ограничение на цену партнёра.
   */
  async listActivePartnerRates(at: Date, partnerId?: Id<'partner'>): Promise<PartnerRateRow[]> {
    const conditions: SQL[] = [lte(partnerRates.effectiveFrom, at)];
    if (partnerId !== undefined) conditions.push(eq(partnerRates.partnerId, partnerId));

    return this.db
      .selectDistinctOn([
        partnerRates.partnerId,
        partnerRates.terminationKind,
        partnerRates.operatorId,
        partnerRates.regionKey,
      ])
      .from(partnerRates)
      .where(and(...conditions))
      .orderBy(
        asc(partnerRates.partnerId),
        asc(partnerRates.terminationKind),
        asc(partnerRates.operatorId),
        sql`${partnerRates.regionKey} asc nulls last`,
        desc(partnerRates.effectiveFrom),
      );
  }

  async insertCommissionRule(
    draft: {
      clientId: Id<'client'> | null;
      fixedFee: MoneyAmount;
      percentBasisPoints: BasisPoints;
      effectiveFrom: Date;
    },
    executor: Executor = this.db,
  ): Promise<CommissionRuleRow> {
    try {
      const [row] = await executor
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

/**
 * Список значений для `in (…)` в сыром запросе.
 *
 * Массив, подставленный в шаблон целиком, уезжает **одним** параметром, и PostgreSQL
 * отвечает «malformed array literal». Развёрнутый список — по параметру на значение,
 * то есть подстановка остаётся связанной, а не склеенной строкой.
 */
function values(items: readonly string[]): SQL {
  return sql.join(
    items.map((item) => sql`${item}`),
    sql`, `,
  );
}

/**
 * Сырая строка `partner_rates` в вид, ожидаемый остальным кодом.
 *
 * Запрос идёт через `execute`, а не через построитель: `distinct on` он не выражает,
 * а обходиться без него значило бы спрашивать цену отдельным запросом на каждого
 * кандидата. Драйвер отдаёт колонки как есть — в змеиной записи и строками,
 * поэтому приведение здесь явное, а не полагается на совпадение имён.
 */
function toPartnerRate(row: Record<string, unknown>): PartnerRateRow {
  return {
    id: row['id'] as PartnerRateRow['id'],
    partnerId: row['partner_id'] as PartnerRateRow['partnerId'],
    operatorId: row['operator_id'] as PartnerRateRow['operatorId'],
    terminationKind: row['termination_kind'] as PartnerRateRow['terminationKind'],
    region: row['region'] as string | null,
    regionKey: row['region_key'] as string | null,
    pricePerMinute: BigInt(row['price_per_minute'] as string) as PartnerRateRow['pricePerMinute'],
    billingIncrementSeconds: Number(row['billing_increment_seconds']),
    minimumDurationSeconds: Number(row['minimum_duration_seconds']),
    connectionFee: BigInt(row['connection_fee'] as string) as PartnerRateRow['connectionFee'],
    rounding: row['rounding'] as PartnerRateRow['rounding'],
    effectiveFrom: new Date(row['effective_from'] as string),
    createdAt: new Date(row['created_at'] as string),
  };
}
