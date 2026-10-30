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
import { CALL_REAL_ANSWER_SECONDS, newId, type FailureScope, type Id } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type FailureThresholdRow = typeof failureThresholds.$inferSelect;

/** Партнёр, у которого порог отказов за окно снял несколько объектов (ADR-0106). */
export interface SuspensionBurst {
  readonly partnerId: Id<'partner'>;
  readonly partnerName: string;
  readonly sims: number;
  readonly gateways: number;
}

/** Попытки группы за окно для отчёта блокировок (ADR-0107). */
// Тип, а не интерфейс: строка результата `execute` обязана быть записью с индексной сигнатурой.
export type BlockAttemptsRow = {
  readonly id: string;
  readonly name: string;
  readonly attempts: number;
  /** Разговор от 5 секунд. */
  readonly realAnswered: number;
  /** Отвечено, но короче 5 секунд. */
  readonly shortAnswered: number;
};

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

/** Транк с подозрительно короткими отвеченными вызовами. */
export interface ShortAnswerRow {
  readonly gatewayId: string;
  readonly gatewayName: string;
  readonly partnerName: string;
  readonly answered: number;
  readonly short: number;
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
   * Отбор сразу по состоянию: уже отключённую отключать второй раз незачем (ADR-0027). Отказы считаются только
   * с последней смены состояния карты и шлюза (ADR-0100): включённую после пробы карту старые отказы, ещё лежащие
   * в окне, иначе сняли бы следующим же проходом.
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
            gte(calls.startedAt, simCards.statusChangedAt),
            gte(calls.startedAt, gateways.statusChangedAt),
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
      .where(
        and(
          gte(calls.startedAt, since),
          gte(calls.startedAt, gateways.statusChangedAt),
          eq(gateways.status, 'active'),
          NETWORK_FAILURE,
        ),
      )
      .groupBy(gateways.id)
      .having(sql`count(*) >= ${failures}`);
  }

  /**
   * Транки, похожие на ложный ответ (ADR-0100, п. 6): с `since` отвечено не меньше `minAnswered`, и не меньше
   * `minShareBasisPoints` из них — короче `maxSeconds`. Провайдер, «снимающий трубку» сам, даёт ровно такую картину.
   */
  async shortAnswerTrunks(
    since: Date,
    rule: { minAnswered: number; maxSeconds: number; minShareBasisPoints: number },
  ): Promise<ShortAnswerRow[]> {
    const shortCalls = sql<number>`count(*) filter (where ${calls.durationSeconds} < ${rule.maxSeconds})::int`;
    return this.db
      .select({
        gatewayId: gateways.id,
        gatewayName: gateways.name,
        partnerName: partners.name,
        answered: sql<number>`count(*)::int`,
        short: shortCalls,
      })
      .from(calls)
      .innerJoin(gateways, eq(gateways.id, calls.gatewayId))
      .innerJoin(partners, eq(partners.id, gateways.partnerId))
      .where(
        and(
          gte(calls.startedAt, since),
          eq(gateways.type, 'sip_trunk'),
          eq(calls.status, 'completed'),
        ),
      )
      .groupBy(gateways.id, gateways.name, partners.name)
      .having(
        and(
          sql`count(*) >= ${rule.minAnswered}`,
          sql`${shortCalls} * 10000 >= count(*) * ${rule.minShareBasisPoints}`,
        ),
      );
  }

  /**
   * Партнёры, у которых порог отказов с `since` снял две SIM или два шлюза и больше (ADR-0106): признак, что оператор
   * режет партнёра целиком. По текущему состоянию — снятое и уже включённое обратно не считается.
   */
  async suspensionBursts(since: Date): Promise<SuspensionBurst[]> {
    const result = await this.db.execute<{
      partner_id: Id<'partner'>;
      partner_name: string;
      sims: number;
      gateways: number;
    }>(sql`
      select p.id as partner_id, p.name as partner_name,
             count(*) filter (where s.kind = 'sim')::int as sims,
             count(*) filter (where s.kind = 'gateway')::int as gateways
        from (
          select partner_id, 'sim' as kind from sim_cards
           where status = 'throttled' and status_changed_at >= ${since.toISOString()}::timestamptz
          union all
          select partner_id, 'gateway' as kind from gateways
           where status = 'suspended' and suspended_by = 'failure_threshold'
             and status_changed_at >= ${since.toISOString()}::timestamptz
        ) s
        join partners p on p.id = s.partner_id
       group by p.id, p.name
      having count(*) >= 2
       order by count(*) desc
    `);
    return result.rows.map((row) => ({
      partnerId: row.partner_id,
      partnerName: row.partner_name,
      sims: row.sims,
      gateways: row.gateways,
    }));
  }

  /**
   * Попытки, ушедшие в сеть с `since`, по партнёрам и по операторам SIM (ADR-0107). Отказы площадки (`failure_reason`
   * заполнен) в сеть не уходили и не считаются. Транки в разрезе операторов не участвуют: оператора у них нет.
   */
  async blockAttempts(
    since: Date,
  ): Promise<{ partners: BlockAttemptsRow[]; operators: BlockAttemptsRow[] }> {
    const real = sql`count(*) filter (where c.answered_at is not null and coalesce(c.duration_seconds, ${CALL_REAL_ANSWER_SECONDS}) >= ${CALL_REAL_ANSWER_SECONDS})::int`;
    const short = sql`count(*) filter (where c.answered_at is not null and c.duration_seconds < ${CALL_REAL_ANSWER_SECONDS})::int`;
    const at = since.toISOString();
    const [partners, operators] = await Promise.all([
      this.db.execute<BlockAttemptsRow>(sql`
        select p.id, p.name, count(*)::int as attempts, ${real} as "realAnswered", ${short} as "shortAnswered"
          from calls c
          join gateways g on g.id = c.gateway_id
          join partners p on p.id = g.partner_id
         where c.started_at >= ${at}::timestamptz and c.failure_reason is null
         group by p.id, p.name`),
      this.db.execute<BlockAttemptsRow>(sql`
        select o.id, o.name, count(*)::int as attempts, ${real} as "realAnswered", ${short} as "shortAnswered"
          from calls c
          join sim_cards s on s.id = c.sim_card_id
          join operators o on o.id = s.operator_id
         where c.started_at >= ${at}::timestamptz and c.failure_reason is null
         group by o.id, o.name`),
    ]);
    return { partners: partners.rows, operators: operators.rows };
  }

  /** Чьи это SIM и шлюзы: партнёр и оператор (у шлюза оператора нет) — для отчёта блокировок. */
  async ownersOf(
    simIds: readonly string[],
    gatewayIds: readonly string[],
  ): Promise<
    {
      id: string;
      partnerId: string;
      partnerName: string;
      operatorId: string | null;
      operatorName: string | null;
    }[]
  > {
    if (simIds.length === 0 && gatewayIds.length === 0) return [];
    const result = await this.db.execute<{
      id: string;
      partnerId: string;
      partnerName: string;
      operatorId: string | null;
      operatorName: string | null;
    }>(sql`
      select s.id::text as id, p.id::text as "partnerId", p.name as "partnerName",
             o.id::text as "operatorId", o.name as "operatorName"
        from sim_cards s
        join partners p on p.id = s.partner_id
        join operators o on o.id = s.operator_id
       where s.id::text = any(${sql.param([...simIds])}::text[])
      union all
      select g.id::text, p.id::text, p.name, null, null
        from gateways g
        join partners p on p.id = g.partner_id
       where g.id::text = any(${sql.param([...gatewayIds])}::text[])`);
    return result.rows;
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
