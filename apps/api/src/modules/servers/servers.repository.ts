/**
 * Замеры серверов: хранение
 * ([ADR-0065](../../../../../docs/adr/0065-sostoyanie-serverov-i-istoriya.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { serverMetrics } from '@zvonix/db/schema';
import { newId, type Id } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type MetricRow = typeof serverMetrics.$inferSelect;

/** Источник замера: узел либо сама площадка (`null`). */
export type MetricSource = Id<'node'> | null;

export interface MetricDraft {
  readonly load1Centi: number;
  readonly cpuCores: number;
  readonly memTotalMb: number;
  readonly memAvailableMb: number;
  readonly diskTotalMb: number;
  readonly diskFreeMb: number;
  readonly activeCalls: number | null;
}

/** Точка графика: усреднённая за корзину нагрузка и худшие за неё память и диск. */
export interface MetricPoint {
  readonly at: Date;
  readonly load1Centi: number;
  readonly memAvailableMb: number;
  readonly diskFreeMb: number;
}

const sourceCondition = (source: MetricSource) =>
  source === null ? isNull(serverMetrics.nodeId) : eq(serverMetrics.nodeId, source);

@Injectable()
export class ServersRepository {
  constructor(private readonly database: DatabaseService) {}

  async insert(source: MetricSource, takenAt: Date, draft: MetricDraft): Promise<void> {
    await this.database.db
      .insert(serverMetrics)
      .values({ id: newId<'serverMetric'>(), nodeId: source, takenAt, ...draft });
  }

  /** Последний замер источника. */
  async latest(source: MetricSource): Promise<MetricRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(serverMetrics)
      .where(sourceCondition(source))
      .orderBy(desc(serverMetrics.takenAt))
      .limit(1);
    return row;
  }

  /**
   * История источника, сжатая в корзины по `bucketSeconds`.
   *
   * Сжатие в базе, а не в приложении: за неделю набегает десять тысяч строк на источник,
   * а графику нужно несколько сотен точек. Нагрузка усредняется, а память и диск берутся
   * по худшему значению корзины — график, на котором провал сгладился, соврал бы.
   */
  async series(source: MetricSource, since: Date, bucketSeconds: number): Promise<MetricPoint[]> {
    const bucket = sql<Date>`to_timestamp(floor(extract(epoch from ${serverMetrics.takenAt}) / ${bucketSeconds}) * ${bucketSeconds})`;
    const rows = await this.database.db
      .select({
        at: bucket.mapWith((value: string | Date) => new Date(value)),
        load1Centi: sql<number>`round(avg(${serverMetrics.load1Centi}))::int`,
        memAvailableMb: sql<number>`min(${serverMetrics.memAvailableMb})::int`,
        diskFreeMb: sql<number>`min(${serverMetrics.diskFreeMb})::int`,
      })
      .from(serverMetrics)
      .where(and(sourceCondition(source), gte(serverMetrics.takenAt, since)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return rows;
  }

  /** Убирает замеры старше срока; возвращает, сколько убрано. */
  async purgeBefore(before: Date): Promise<number> {
    const removed = await this.database.db
      .delete(serverMetrics)
      .where(lt(serverMetrics.takenAt, before))
      .returning({ id: serverMetrics.id });
    return removed.length;
  }
}
