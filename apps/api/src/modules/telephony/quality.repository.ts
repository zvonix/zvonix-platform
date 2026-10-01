/**
 * Качество терминации и пороги отключения
 * ([ADR-0027](../../../../../docs/adr/0027-porog-otklyucheniya.md)).
 *
 * Всё считается по таблице вызовов — отдельного счётчика нет: качество спрашивают редко
 * и не в горячем пути, а вызовы и так пишутся все до одного.
 */

import { Injectable } from '@nestjs/common';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { toDatabaseError, type Database } from '@zvonix/db';
import { calls, failureThresholds, gateways, partners, simCards } from '@zvonix/db/schema';
import { newId, type FailureScope, type Id } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type FailureThresholdRow = typeof failureThresholds.$inferSelect;

/** Качество одного объекта за окно. */
export interface QualityRow {
  readonly subjectId: string;
  /** Номер SIM или название шлюза — как человек опознаёт объект. */
  readonly subjectName: string;
  /** Состояние объекта: отключённый порогом виден прямо в разборе. */
  readonly subjectStatus: string;
  readonly partnerId: Id<'partner'>;
  readonly partnerName: string;
  /** Сколько вызовов вообще ушло на объект. */
  readonly attempts: number;
  /** Сколько из них было отвечено: разговор состоялся. */
  readonly answered: number;
  /** Отказы сети — то, что считает порог (ADR-0027). */
  readonly networkFailures: number;
  /** Суммарная длительность отвеченных, секунды. */
  readonly talkSeconds: number;
}

/** Объект, набравший отказов сверх порога. */
export interface FailureCount {
  readonly subjectId: string;
  readonly failures: number;
}

/**
 * Отказ, за который отвечает сеть, а не абонент и не платформа.
 *
 * `status = 'failed'` при пустой причине: причину заполняет **только** control plane,
 * когда отказывает сам, а отказ из телефонии приходит с одним лишь кодом разъединения.
 * `no_answer`, `busy` и `cancelled` сюда не входят — это поведение абонента, и отключать
 * за него SIM партнёра значит наказывать его за чужих людей.
 */
const NETWORK_FAILURE = and(eq(calls.status, 'failed'), isNull(calls.failureReason));

/**
 * Сколько объектов отдаётся в разборе качества.
 *
 * Разбор читает человек, а не машина: две сотни строк, отсортированных по отказам,
 * отвечают на вопрос «у кого хуже всех», а полная выгрузка по тысяче SIM за месяц —
 * это ответ, который никто не дочитает, и время, которое база потратит зря.
 */
const QUALITY_LIMIT = 200;

@Injectable()
export class QualityRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db(): Database {
    return this.database.db;
  }

  /** Качество по SIM за окно. Партнёр берётся у SIM: по нему группируют разбор. */
  async simQuality(since: Date, partnerId?: Id<'partner'>): Promise<QualityRow[]> {
    const rows = await this.db
      .select({
        subjectId: simCards.id,
        subjectName: simCards.msisdn,
        subjectStatus: simCards.status,
        partnerId: simCards.partnerId,
        partnerName: partners.name,
        attempts: sql<number>`count(*)::int`,
        answered: sql<number>`count(*) filter (where ${calls.status} = 'completed')::int`,
        networkFailures: sql<number>`count(*) filter (where ${NETWORK_FAILURE})::int`,
        talkSeconds: sql<number>`coalesce(sum(${calls.durationSeconds}), 0)::int`,
      })
      .from(calls)
      .innerJoin(simCards, eq(simCards.id, calls.simCardId))
      .innerJoin(partners, eq(partners.id, simCards.partnerId))
      .where(
        partnerId === undefined
          ? gte(calls.startedAt, since)
          : and(gte(calls.startedAt, since), eq(simCards.partnerId, partnerId)),
      )
      .groupBy(simCards.id, simCards.msisdn, simCards.status, simCards.partnerId, partners.name)
      .orderBy(sql`count(*) filter (where ${NETWORK_FAILURE}) desc`)
      .limit(QUALITY_LIMIT);

    return rows;
  }

  /** То же по шлюзам: неисправен бывает не только пластик, но и железо. */
  async gatewayQuality(since: Date, partnerId?: Id<'partner'>): Promise<QualityRow[]> {
    const rows = await this.db
      .select({
        subjectId: gateways.id,
        subjectName: gateways.name,
        subjectStatus: gateways.status,
        partnerId: gateways.partnerId,
        partnerName: partners.name,
        attempts: sql<number>`count(*)::int`,
        answered: sql<number>`count(*) filter (where ${calls.status} = 'completed')::int`,
        networkFailures: sql<number>`count(*) filter (where ${NETWORK_FAILURE})::int`,
        talkSeconds: sql<number>`coalesce(sum(${calls.durationSeconds}), 0)::int`,
      })
      .from(calls)
      .innerJoin(gateways, eq(gateways.id, calls.gatewayId))
      .innerJoin(partners, eq(partners.id, gateways.partnerId))
      .where(
        partnerId === undefined
          ? gte(calls.startedAt, since)
          : and(gte(calls.startedAt, since), eq(gateways.partnerId, partnerId)),
      )
      .groupBy(gateways.id, gateways.name, gateways.status, gateways.partnerId, partners.name)
      .orderBy(sql`count(*) filter (where ${NETWORK_FAILURE}) desc`)
      .limit(QUALITY_LIMIT);

    return rows;
  }

  /**
   * SIM, набравшие отказов сети не меньше порога и **ещё работающие**.
   *
   * Отбор сразу по состоянию: уже отключённую отключать второй раз незачем, а вернуть
   * её в строй — дело человека (ADR-0027).
   */
  async simsOverThreshold(since: Date, failures: number): Promise<FailureCount[]> {
    return (
      this.db
        .select({
          subjectId: simCards.id,
          failures: sql<number>`count(*)::int`,
        })
        .from(calls)
        .innerJoin(simCards, eq(simCards.id, calls.simCardId))
        // Шлюз проверяется тоже: SIM неисправного шлюза отказывает не потому, что
        // с ней что-то не так, и отключать её отдельно значит заставить партнёра
        // включать обратно два объекта вместо одного.
        .innerJoin(gateways, eq(gateways.id, calls.gatewayId))
        .where(
          and(
            gte(calls.startedAt, since),
            eq(simCards.status, 'active'),
            eq(gateways.status, 'active'),
            NETWORK_FAILURE,
          ),
        )
        .groupBy(simCards.id)
        .having(sql`count(*) >= ${failures}`)
    );
  }

  async gatewaysOverThreshold(since: Date, failures: number): Promise<FailureCount[]> {
    return this.db
      .select({
        subjectId: gateways.id,
        failures: sql<number>`count(*)::int`,
      })
      .from(calls)
      .innerJoin(gateways, eq(gateways.id, calls.gatewayId))
      .where(and(gte(calls.startedAt, since), eq(gateways.status, 'active'), NETWORK_FAILURE))
      .groupBy(gateways.id)
      .having(sql`count(*) >= ${failures}`);
  }

  // --- Пороги ---------------------------------------------------------------------

  async listThresholds(): Promise<FailureThresholdRow[]> {
    return this.db.select().from(failureThresholds).orderBy(failureThresholds.scope);
  }

  async findThreshold(scope: FailureScope): Promise<FailureThresholdRow | undefined> {
    const [row] = await this.db
      .select()
      .from(failureThresholds)
      .where(eq(failureThresholds.scope, scope));
    return row;
  }

  /**
   * Заводит порог области или меняет его.
   *
   * Один порог на область: два означали бы, что срабатывает тот, который прочитали
   * первым. Отсюда и `on conflict` вместо пары «найти и решить».
   */
  async upsertThreshold(draft: {
    scope: FailureScope;
    failures: number;
    windowMinutes: number;
  }): Promise<FailureThresholdRow> {
    try {
      const [row] = await this.db
        .insert(failureThresholds)
        .values({ id: newId<'failureThreshold'>(), ...draft })
        .onConflictDoUpdate({
          target: failureThresholds.scope,
          set: {
            failures: draft.failures,
            windowMinutes: draft.windowMinutes,
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

  async deleteThreshold(scope: FailureScope): Promise<FailureThresholdRow | undefined> {
    const [row] = await this.db
      .delete(failureThresholds)
      .where(eq(failureThresholds.scope, scope))
      .returning();
    return row;
  }
}
