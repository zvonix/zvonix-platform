/**
 * Доступ к справочнику операторов и базе разрешений (ADR-0013).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { orderByText, toDatabaseError } from '@zvonix/db';
import {
  numberResolutions,
  numberingPlanRanges,
  operatorAliases,
  operators,
} from '@zvonix/db/schema';
import {
  newId,
  toNumeric,
  type Id,
  type Msisdn,
  type NumberingPlanSource,
  type ResolutionSource,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';
import { normalizeOperatorName } from './operator-name.js';

export type OperatorId = Id<'operator'>;
export type OperatorRow = typeof operators.$inferSelect;
export type NumberResolutionRow = typeof numberResolutions.$inferSelect;

export interface NewOperator {
  readonly name: string;
  readonly inn: string | null;
  readonly mnc: string | null;
  readonly isMvno: boolean;
  readonly hostOperatorId: OperatorId | null;
  /**
   * Когда запись подтверждена человеком
   * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
   *
   * У заведённой администратором — момент создания: её создавал человек, и он же
   * назвал признак MVNO и хозяина сети. Пусто бывает только у записи из импорта.
   */
  readonly verifiedAt: Date | null;
}

/** Диапазон, готовый к записи: оператор уже сопоставлен справочнику. */
export interface NewPlanRange {
  readonly defCode: string;
  readonly rangeStart: bigint;
  readonly rangeEnd: bigint;
  readonly capacity: number;
  readonly operatorId: OperatorId;
  readonly region: string | null;
}

/**
 * Сколько диапазонов вставляется одним запросом.
 *
 * Не весь набор разом: PostgreSQL принимает не больше 65 535 параметров в запросе,
 * а на диапазон их девять — семнадцать тысяч строк в один `insert` не поместятся.
 */
const PLAN_INSERT_CHUNK = 2000;

export interface StoredResolution {
  readonly msisdn: Msisdn;
  readonly operatorId: OperatorId;
  readonly previousOperatorId: OperatorId | null;
  readonly region: string | null;
  readonly source: ResolutionSource;
  readonly resolvedAt: Date;
  readonly expiresAt: Date;
}

@Injectable()
export class CatalogRepository {
  constructor(private readonly database: DatabaseService) {}

  // --- Операторы -------------------------------------------------------------

  async createOperator(draft: NewOperator): Promise<OperatorRow> {
    try {
      const [row] = await this.database.db
        .insert(operators)
        .values({ id: newId<'operator'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findOperator(id: OperatorId): Promise<OperatorRow | undefined> {
    const [row] = await this.database.db.select().from(operators).where(eq(operators.id, id));
    return row;
  }

  async listOperators(): Promise<OperatorRow[]> {
    return this.database.db.select().from(operators).orderBy(orderByText(operators.name));
  }

  /**
   * Подтверждённые операторы — только имя и идентификатор.
   *
   * Отдельно от `listOperators`: там строка целиком и все синонимы к ней, а справочник
   * наполнен планом нумерации. Неподтверждённые сюда не попадают намеренно — по такому
   * оператору вызов не совершается ни у кого
   * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)), и в разговоре
   * «где у партнёра нет цены» он был бы ложным следом.
   */
  async listVerifiedOperators(): Promise<{ id: OperatorId; name: string }[]> {
    return this.database.db
      .select({ id: operators.id, name: operators.name })
      .from(operators)
      .where(isNotNull(operators.verifiedAt))
      .orderBy(orderByText(operators.name));
  }

  /**
   * Названия операторов пачкой.
   *
   * Отдельно от `listOperators`: справочник наполнен планом нумерации и содержит
   * сотни записей, а списку вызовов нужны имена десятка операторов со страницы.
   */
  async operatorNamesOf(ids: readonly OperatorId[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.database.db
      .select({ id: operators.id, name: operators.name })
      .from(operators)
      .where(inArray(operators.id, [...ids]));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /**
   * Оператор по написанию названия из внешнего источника.
   *
   * Ищется по таблице синонимов, а не по названию: источники называют одного
   * оператора по-разному, и сравнение названий строками завело бы трёх операторов
   * вместо одного.
   */
  async findOperatorByName(name: string): Promise<OperatorRow | undefined> {
    const alias = normalizeOperatorName(name);
    if (alias === '') return undefined;

    const [row] = await this.database.db
      .select({ operator: operators })
      .from(operatorAliases)
      .innerJoin(operators, eq(operators.id, operatorAliases.operatorId))
      .where(eq(operatorAliases.alias, alias));
    return row?.operator;
  }

  async addAlias(operatorId: OperatorId, name: string): Promise<string> {
    const alias = normalizeOperatorName(name);
    try {
      await this.database.db
        .insert(operatorAliases)
        .values({ id: newId<'operatorAlias'>(), operatorId, alias });
      return alias;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Написания сразу у всех операторов.
   *
   * Одним запросом, а не по запросу на оператора: справочник читается целиком,
   * и `N+1` здесь означал бы полсотни обращений к базе на один ответ.
   */
  async listAliasesByOperators(): Promise<Map<OperatorId, string[]>> {
    const rows = await this.database.db
      .select({ operatorId: operatorAliases.operatorId, alias: operatorAliases.alias })
      .from(operatorAliases)
      .orderBy(asc(operatorAliases.operatorId), asc(operatorAliases.alias));

    const grouped = new Map<OperatorId, string[]>();
    for (const row of rows) {
      const existing = grouped.get(row.operatorId);
      if (existing === undefined) grouped.set(row.operatorId, [row.alias]);
      else existing.push(row.alias);
    }
    return grouped;
  }

  async listAliases(operatorId: OperatorId): Promise<string[]> {
    const rows = await this.database.db
      .select({ alias: operatorAliases.alias })
      .from(operatorAliases)
      .where(eq(operatorAliases.operatorId, operatorId))
      .orderBy(asc(operatorAliases.alias));
    return rows.map((row) => row.alias);
  }

  // --- План нумерации --------------------------------------------------------

  /**
   * Оператор, которому **выделен** диапазон с этим номером.
   *
   * Это не тот же вопрос, что «кто обслуживает номер»: для перенесённого номера
   * ответы различаются, и именно поэтому такое разрешение не подтверждает оператора.
   *
   * При двух свидетельствах из разных источников берётся более узкий диапазон:
   * он точнее описывает выделение.
   */
  async findRangeOwner(
    msisdn: Msisdn,
  ): Promise<{ operator: OperatorRow; region: string | null } | undefined> {
    const numeric = toNumeric(msisdn);

    const [row] = await this.database.db
      .select({ operator: operators, region: numberingPlanRanges.region })
      .from(numberingPlanRanges)
      .innerJoin(operators, eq(operators.id, numberingPlanRanges.operatorId))
      .where(
        and(
          lte(numberingPlanRanges.rangeStart, numeric),
          sql`${numberingPlanRanges.rangeEnd} >= ${numeric}`,
        ),
      )
      .orderBy(sql`${numberingPlanRanges.rangeEnd} - ${numberingPlanRanges.rangeStart} asc`)
      .limit(1);

    return row;
  }

  /** Когда план нумерации этого источника загружался последний раз. */
  async lastPlanImportAt(source: NumberingPlanSource): Promise<Date | undefined> {
    const [row] = await this.database.db
      .select({ importedAt: sql<Date | null>`max(${numberingPlanRanges.importedAt})` })
      .from(numberingPlanRanges)
      .where(eq(numberingPlanRanges.source, source));
    return row?.importedAt ?? undefined;
  }

  /**
   * Операторы по ИНН — одним запросом.
   *
   * Импорт сопоставляет семнадцать тысяч строк с семью десятками операторов: запрос
   * на строку означал бы семнадцать тысяч обращений к базе за один проход.
   */
  async findOperatorsByInn(inns: readonly string[]): Promise<Map<string, OperatorRow>> {
    if (inns.length === 0) return new Map();

    const rows = await this.database.db
      .select()
      .from(operators)
      .where(inArray(operators.inn, [...inns]));

    const found = new Map<string, OperatorRow>();
    for (const row of rows) if (row.inn !== null) found.set(row.inn, row);
    return found;
  }

  /**
   * Заводит оператора по данным плана нумерации — **непроверенным**
   * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
   *
   * `verifiedAt` пуст: файл не говорит, виртуальный оператор или нет, а `is_mvno = false`
   * в проверенной записи означало бы утверждение «своя сеть», которого никто не делал.
   * Название сразу уходит и в синонимы, иначе оператор не найдётся по ответу внешнего
   * сервиса.
   */
  async createImportedOperator(draft: { name: string; inn: string | null }): Promise<OperatorRow> {
    try {
      return await this.database.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(operators)
          .values({
            id: newId<'operator'>(),
            name: draft.name,
            inn: draft.inn,
            mnc: null,
            isMvno: false,
            hostOperatorId: null,
            verifiedAt: null,
          })
          .returning();
        if (row === undefined) throw new Error('Вставка не вернула строку');

        await tx
          .insert(operatorAliases)
          .values({
            id: newId<'operatorAlias'>(),
            operatorId: row.id,
            alias: normalizeOperatorName(draft.name),
          })
          .onConflictDoNothing();

        return row;
      });
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /** Добавляет написание, если его ещё нет. Импорт повторяется ежедневно. */
  async ensureAlias(operatorId: OperatorId, name: string): Promise<void> {
    const alias = normalizeOperatorName(name);
    if (alias === '') return;

    try {
      await this.database.db
        .insert(operatorAliases)
        .values({ id: newId<'operatorAlias'>(), operatorId, alias })
        .onConflictDoNothing();
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Человек подтвердил запись оператора ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
   *
   * Подтверждение и есть ответ на три вопроса — своя сеть или нет, чья сеть, какой MNC:
   * отметить запись проверенной, не назвав их, значит ничего не проверить.
   */
  async verifyOperator(
    id: OperatorId,
    patch: { isMvno: boolean; hostOperatorId: OperatorId | null; mnc: string | null },
    at: Date,
  ): Promise<OperatorRow | undefined> {
    try {
      const [row] = await this.database.db
        .update(operators)
        .set({ ...patch, verifiedAt: at, updatedAt: at })
        .where(eq(operators.id, id))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /**
   * Заменяет план нумерации источника целиком — одной транзакцией
   * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
   *
   * Не «обновить изменившееся»: диапазоны в файле не имеют устойчивого идентификатора,
   * и вычислять разницу пришлось бы по границам, то есть по тому же объёму работы.
   * Целиком и в транзакции — потому что читатели обязаны видеть либо прежний план,
   * либо новый, но никогда половину: в разрыве часть номеров перестала бы определяться.
   */
  async replaceNumberingPlan(
    source: NumberingPlanSource,
    ranges: readonly NewPlanRange[],
    importedAt: Date,
  ): Promise<number> {
    try {
      return await this.database.db.transaction(async (tx) => {
        await tx.delete(numberingPlanRanges).where(eq(numberingPlanRanges.source, source));

        for (let from = 0; from < ranges.length; from += PLAN_INSERT_CHUNK) {
          const chunk = ranges.slice(from, from + PLAN_INSERT_CHUNK);
          await tx.insert(numberingPlanRanges).values(
            chunk.map((range) => ({
              id: newId<'numberingPlanRange'>(),
              defCode: range.defCode,
              rangeStart: range.rangeStart,
              rangeEnd: range.rangeEnd,
              capacity: range.capacity,
              operatorId: range.operatorId,
              region: range.region,
              source,
              importedAt,
            })),
          );
        }

        return ranges.length;
      });
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  // --- База разрешений -------------------------------------------------------

  /** Действующая запись: не просроченная и не отменённая обращением партнёра. */
  async findLiveResolution(msisdn: Msisdn, now: Date): Promise<NumberResolutionRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(numberResolutions)
      .where(
        and(
          eq(numberResolutions.msisdn, msisdn),
          isNull(numberResolutions.invalidatedAt),
          sql`${numberResolutions.expiresAt} > ${now}`,
        ),
      );
    return row;
  }

  /**
   * Сохраняет разрешение, перезаписывая прежнее по тому же номеру.
   *
   * Номер один, запись одна: копить историю разрешений здесь не нужно — для разбора
   * спора о цене служит отметка в CDR, где записано, чем определён оператор
   * на момент конкретного вызова.
   */
  async saveResolution(draft: StoredResolution): Promise<NumberResolutionRow> {
    try {
      const [row] = await this.database.db
        .insert(numberResolutions)
        .values({ id: newId<'numberResolution'>(), ...draft })
        .onConflictDoUpdate({
          target: numberResolutions.msisdn,
          set: {
            operatorId: draft.operatorId,
            previousOperatorId: draft.previousOperatorId,
            region: draft.region,
            source: draft.source,
            resolvedAt: draft.resolvedAt,
            expiresAt: draft.expiresAt,
            // Новое разрешение снимает отметку об ошибке: номер разрешён заново.
            invalidatedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /** Отмечает обращение к номеру: по этому полю фоновое обновление выбирает, что важнее. */
  async registerUse(msisdn: Msisdn, at: Date): Promise<void> {
    await this.database.db
      .update(numberResolutions)
      .set({ lastUsedAt: at, useCount: sql`${numberResolutions.useCount} + 1` })
      .where(eq(numberResolutions.msisdn, msisdn));
  }

  /**
   * Отменяет запись по обращению партнёра «вызов ушёл не в мою сеть».
   *
   * Действует немедленно, независимо от срока годности: партнёр видит счёт от своего
   * оператора и знает про ошибку раньше нас. Возвращает `true`, если было что отменять.
   */
  async invalidateResolution(msisdn: Msisdn, at: Date): Promise<boolean> {
    const rows = await this.database.db
      .update(numberResolutions)
      .set({ invalidatedAt: at })
      .where(and(eq(numberResolutions.msisdn, msisdn), isNull(numberResolutions.invalidatedAt)))
      .returning({ id: numberResolutions.id });
    return rows.length > 0;
  }

  /**
   * Номера, требующие фонового обновления: просроченные или отменённые.
   *
   * Порядок — по востребованности: сначала те, по которым звонят чаще. Номера,
   * по которым не звонят, не обновляются никогда и не стоят ничего.
   */
  async findStaleResolutions(now: Date, limit: number): Promise<NumberResolutionRow[]> {
    return this.database.db
      .select()
      .from(numberResolutions)
      .where(
        or(
          sql`${numberResolutions.expiresAt} <= ${now}`,
          sql`${numberResolutions.invalidatedAt} is not null`,
        ),
      )
      .orderBy(sql`${numberResolutions.useCount} desc`, asc(numberResolutions.expiresAt))
      .limit(limit);
  }
}
