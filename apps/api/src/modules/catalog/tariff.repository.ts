/**
 * Запросы к тарифам партнёров и наценке платформы (ADR-0010).
 *
 * Подбор действующей записи устроен одинаково у обеих таблиц: берётся самая свежая
 * из тех, что уже действуют на момент вызова. Записи не редактируются — добавляются
 * новые, поэтому история цен остаётся целой, а прошлые звонки не переоцениваются.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { orderByText, toDatabaseError, type Database, type Executor } from '@zvonix/db';
import { commissionRules, partnerRates, partnerTariffs, priceBands } from '@zvonix/db/schema';
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
export type PartnerTariffRow = typeof partnerTariffs.$inferSelect;

/** Имя тарифа по умолчанию, который получает каждый партнёр (ADR-0056). */
export const DEFAULT_TARIFF_NAME = 'Основной';

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
      tariffId: Id<'partnerTariff'>;
      /** Пусто — цена на все операторы тарифа (ADR-0056). */
      operatorId: Id<'operator'> | null;
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
    // Без названного тарифа — тариф партнёра по умолчанию (ADR-0056): так спрашивают
    // калькулятор площадки и CDR вызовов, маршрутизированных до тарифов. Цена без тарифа
    // — строка, записанная прежним кодом в окне выкладки, — читается как его цена.
    const [row] = await this.db
      .select()
      .from(partnerRates)
      .where(
        and(
          eq(partnerRates.partnerId, partnerId),
          sql`(${partnerRates.tariffId} is null or ${partnerRates.tariffId} in (select id from partner_tariffs where partner_id = ${partnerId} and is_default))`,
          or(eq(partnerRates.operatorId, operatorId), isNull(partnerRates.operatorId)),
          eq(partnerRates.terminationKind, terminationKind),
          lte(partnerRates.effectiveFrom, at),
          regionCondition(region),
        ),
      )
      .orderBy(...SPECIFICITY, desc(partnerRates.effectiveFrom))
      .limit(1);

    return row;
  }

  /**
   * Действующие цены нескольких тарифов по одному направлению — по одной на тариф.
   *
   * Отбор кандидатов спрашивает цену каждой SIM по её тарифу
   * ([ADR-0056](../../../../../docs/adr/0056-tarify-partnyora.md)) одним запросом на всех:
   * по запросу на кандидата — десяток обращений в горячем пути.
   *
   * Старшинство внутри тарифа: оператор номера с регионом → оператор без региона →
   * все операторы с регионом → все операторы. Среди равных — самая свежая из действующих.
   * Правило то же, что у `findPartnerRate`: расхождение означало бы, что вызов уходит
   * по одной цене, а тарифицируется по другой.
   */
  async findEffectiveRatesByTariffs(
    tariffIds: readonly Id<'partnerTariff'>[],
    operatorId: Id<'operator'>,
    terminationKind: TerminationKind,
    region: string | null,
    at: Date,
  ): Promise<Map<string, PartnerRateRow>> {
    if (tariffIds.length === 0) return new Map();

    const keys = regionKeysOf(region);
    const regionMatches =
      keys.length === 0
        ? sql`region_key is null`
        : sql`(region_key is null or region_key in (${values(keys)}))`;

    const result = await this.db.execute(sql`
      select distinct on (tariff_id) *
        from partner_rates
       where tariff_id in (${values(tariffIds)})
         and (operator_id = ${operatorId} or operator_id is null)
         and termination_kind = ${terminationKind}
         and effective_from <= ${at}
         and ${regionMatches}
       order by tariff_id,
                case when operator_id is null then 1 else 0 end,
                case when region_key is null then 1 else 0 end,
                effective_from desc
    `);

    return new Map(result.rows.map((row) => [String(row['tariff_id']), toPartnerRate(row)]));
  }

  async findRate(id: Id<'partnerRate'>): Promise<PartnerRateRow | undefined> {
    const [row] = await this.db.select().from(partnerRates).where(eq(partnerRates.id, id));
    return row;
  }

  // --- Тарифы партнёра (ADR-0056) ----------------------------------------------

  async listTariffs(partnerId: Id<'partner'>): Promise<PartnerTariffRow[]> {
    return this.db
      .select()
      .from(partnerTariffs)
      .where(eq(partnerTariffs.partnerId, partnerId))
      .orderBy(desc(partnerTariffs.isDefault), orderByText(partnerTariffs.name));
  }

  async findTariff(
    id: Id<'partnerTariff'>,
    executor: Executor = this.db,
  ): Promise<PartnerTariffRow | undefined> {
    const [row] = await executor.select().from(partnerTariffs).where(eq(partnerTariffs.id, id));
    return row;
  }

  /** Тарифы по умолчанию названных партнёров: партнёр → тариф. */
  async defaultTariffs(
    partnerIds: readonly Id<'partner'>[],
  ): Promise<Map<string, Id<'partnerTariff'>>> {
    if (partnerIds.length === 0) return new Map();
    const rows = await this.db
      .select({ partnerId: partnerTariffs.partnerId, id: partnerTariffs.id })
      .from(partnerTariffs)
      .where(
        and(inArray(partnerTariffs.partnerId, [...partnerIds]), eq(partnerTariffs.isDefault, true)),
      );
    return new Map(rows.map((row) => [row.partnerId, row.id]));
  }

  /**
   * Тариф по умолчанию партнёра — заводится, если его нет.
   *
   * У каждого партнёра он обязан быть: к нему привязана SIM, у которой ни своего
   * тарифа, ни тарифа шлюза. Миграция завела его всем, кто был; новым — здесь.
   * Одновременный вызов упрётся в частичный уникальный индекс и промолчит.
   */
  async ensureDefaultTariff(
    partnerId: Id<'partner'>,
    executor: Executor = this.db,
  ): Promise<PartnerTariffRow> {
    try {
      await executor
        .insert(partnerTariffs)
        .values({
          id: newId<'partnerTariff'>(),
          partnerId,
          name: DEFAULT_TARIFF_NAME,
          isDefault: true,
        })
        .onConflictDoNothing();
    } catch (cause) {
      throw toDatabaseError(cause);
    }
    const [row] = await executor
      .select()
      .from(partnerTariffs)
      .where(and(eq(partnerTariffs.partnerId, partnerId), eq(partnerTariffs.isDefault, true)));
    if (row === undefined) throw new Error('Тариф по умолчанию не заведён');
    return row;
  }

  async insertTariff(
    draft: { partnerId: Id<'partner'>; name: string },
    executor: Executor = this.db,
  ): Promise<PartnerTariffRow> {
    try {
      const [row] = await executor
        .insert(partnerTariffs)
        .values({ id: newId<'partnerTariff'>(), ...draft, isDefault: false })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async renameTariff(
    id: Id<'partnerTariff'>,
    name: string,
    executor: Executor = this.db,
  ): Promise<PartnerTariffRow | undefined> {
    try {
      const [row] = await executor
        .update(partnerTariffs)
        .set({ name })
        .where(eq(partnerTariffs.id, id))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Делает тариф тарифом по умолчанию. Прежний снимается первым: частичный уникальный
   * индекс не пустил бы двух сразу даже на время одного оператора.
   */
  async makeDefaultTariff(
    partnerId: Id<'partner'>,
    id: Id<'partnerTariff'>,
    executor: Executor,
  ): Promise<void> {
    try {
      await executor
        .update(partnerTariffs)
        .set({ isDefault: false })
        .where(and(eq(partnerTariffs.partnerId, partnerId), eq(partnerTariffs.isDefault, true)));
      await executor
        .update(partnerTariffs)
        .set({ isDefault: true })
        .where(eq(partnerTariffs.id, id));
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Удаляет тариф вместе с его ценами.
   *
   * Удаление держат внешние ключи, а не проверка перед ним: тариф, выбранный у шлюза
   * или SIM, и цена, по которой уже был вызов, не удаляются (`restrict`) — проверка
   * заранее разошлась бы с одновременной привязкой.
   */
  async deleteTariff(id: Id<'partnerTariff'>, executor: Executor): Promise<void> {
    try {
      await executor.delete(partnerRates).where(eq(partnerRates.tariffId, id));
      await executor.delete(partnerTariffs).where(eq(partnerTariffs.id, id));
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /** Запирает тарифы партнёра до конца транзакции: смена умолчания и удаление — по очереди. */
  async lockPartnerTariffs(partnerId: Id<'partner'>, executor: Executor): Promise<void> {
    await executor
      .select({ id: partnerTariffs.id })
      .from(partnerTariffs)
      .where(eq(partnerTariffs.partnerId, partnerId))
      .for('update');
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

    // Цена «на все операторы» относится и к названному оператору (ADR-0056).
    const byOperator =
      operatorId === undefined
        ? sql`true`
        : sql`(operator_id = ${operatorId} or operator_id is null)`;

    // По строке на тариф: у SIM партнёра могут быть разные тарифы, и прайс клиента
    // показывает диапазон по всем.
    const result = await this.db.execute(sql`
      select distinct on (partner_id, tariff_id, termination_kind, operator_id, region_key) *
        from partner_rates
       where partner_id in (${values(partnerIds)})
         and effective_from <= ${at}
         and ${byOperator}
       order by partner_id, tariff_id, termination_kind, operator_id, region_key, effective_from desc
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
  async lockOperatorTariffs(
    operatorId: Id<'operator'> | null,
    executor: Executor,
    purpose: 'rate' | 'band' = 'rate',
  ): Promise<void> {
    // Цена «на все операторы» проверяется коридорами **всех** операторов (ADR-0056):
    // её запись берёт общий ключ исключительно, а запись коридора — разделяемо. Так
    // коридоры разных операторов по-прежнему пишутся параллельно, но ни один не проскочит
    // между проверкой и записью цены на всех.
    if (operatorId === null) {
      await executor.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${ALL_OPERATORS_LOCK}, 0))`,
      );
      return;
    }
    if (purpose === 'band') {
      await executor.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${ALL_OPERATORS_LOCK}, 0))`,
      );
    }
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
  async listActivePriceBands(at: Date, executor: Executor = this.db): Promise<PriceBandRow[]> {
    return executor
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

    // Тариф — часть ключа (ADR-0056): одно направление в двух тарифах — две цены.
    return this.db
      .selectDistinctOn([
        partnerRates.partnerId,
        partnerRates.tariffId,
        partnerRates.terminationKind,
        partnerRates.operatorId,
        partnerRates.regionKey,
      ])
      .from(partnerRates)
      .where(and(...conditions))
      .orderBy(
        asc(partnerRates.partnerId),
        sql`${partnerRates.tariffId} asc nulls last`,
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

/** Ключ блокировки цены «на все операторы»; с префиксом, как и ключ оператора. */
const ALL_OPERATORS_LOCK = 'tariff:*';

/**
 * Старшинство строк цены (ADR-0056): оператор номера раньше «всех операторов»,
 * регион раньше «любого региона». Свежесть — уже внутри уровня.
 */
const SPECIFICITY = [
  sql`case when ${partnerRates.operatorId} is null then 1 else 0 end`,
  sql`case when ${partnerRates.regionKey} is null then 1 else 0 end`,
] as const;

/** Регион цены подходит номеру: совпал один из ключей или цена на любой регион. */
function regionCondition(region: string | null): SQL | undefined {
  const keys = regionKeysOf(region);
  return keys.length === 0
    ? isNull(partnerRates.regionKey)
    : or(isNull(partnerRates.regionKey), inArray(partnerRates.regionKey, keys));
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
    tariffId: row['tariff_id'] as PartnerRateRow['tariffId'],
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
