/**
 * Доступ к справочнику операторов и базе разрешений (ADR-0013).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { toDatabaseError } from '@zvonix/db';
import {
  numberResolutions,
  numberingPlanRanges,
  operatorAliases,
  operators,
} from '@zvonix/db/schema';
import { newId, toNumeric, type Id, type Msisdn, type ResolutionSource } from '@zvonix/shared';
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
}

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
    return this.database.db.select().from(operators).orderBy(asc(operators.name));
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
