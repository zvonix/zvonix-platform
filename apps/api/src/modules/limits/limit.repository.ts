/**
 * Запросы к лимитам и их счётчикам ([ADR-0026](../../../../../docs/adr/0026-limity-po-oknam.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { toDatabaseError, type Database, type Executor } from '@zvonix/db';
import { limitCounters, limitRules } from '@zvonix/db/schema';
import {
  newId,
  type Id,
  type LimitMetric,
  type LimitRounding,
  type LimitSetBy,
  type LimitWindow,
} from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type LimitRuleId = Id<'limitRule'>;
export type LimitRuleRow = typeof limitRules.$inferSelect;

/** Исполнитель запроса: пул или транзакция. */
// Тип объявлен в `@zvonix/db` и переэкспортируется отсюда: вызывающий берёт его
// там же, где метод, а определение остаётся одно на весь проект.
export type { Executor };

/**
 * Субъекты, чьи лимиты нужны.
 *
 * Партнёры и SIM — множествами: на горячем пути их столько, сколько кандидатов,
 * и спрашивать по одному значило бы `N+1` там, где счёт идёт на миллисекунды.
 */
export interface LimitSubjects {
  readonly clientId?: Id<'client'>;
  readonly channelId?: Id<'channel'>;
  readonly partnerIds?: readonly Id<'partner'>[];
  readonly simCardIds?: readonly Id<'simCard'>[];
  /** Тарифы партнёров: их лимиты действуют на каждую карту с этим тарифом (ADR-0080). */
  readonly tariffIds?: readonly Id<'partnerTariff'>[];
}

/** Начало окна у конкретного правила: вычисляется вызывающим одной и той же функцией. */
/**
 * Счётчик: правило, окно и — у правила «на каждую карту» — SIM (ADR-0057).
 * У прочих правил `simCardId` пуст: счётчик один на правило.
 */
export interface CounterKey {
  readonly ruleId: LimitRuleId;
  readonly simCardId: Id<'simCard'> | null;
  readonly bucketStart: Date;
}

/** Израсходованное по счётчику: правило, SIM (или пусто) и сумма. */
export interface CounterAmount {
  readonly ruleId: LimitRuleId;
  readonly simCardId: Id<'simCard'> | null;
  readonly amount: number;
}

/** Ключ счётчика строкой — для словаря: правило и SIM. */
export function counterKeyOf(ruleId: LimitRuleId, simCardId: Id<'simCard'> | null): string {
  return `${ruleId}|${simCardId ?? ''}`;
}

/** Сколько живут счётчики коротких окон: минутные и часовые нужны только сейчас. */
const SHORT_WINDOWS: readonly LimitWindow[] = ['minute', 'hour'];

@Injectable()
export class LimitRepository {
  constructor(private readonly database: DatabaseService) {}

  get db(): Database {
    return this.database.db;
  }

  /**
   * Правила перечисленных субъектов — одним запросом.
   *
   * Пустой набор субъектов даёт пустой ответ **без обращения к базе**: у большинства
   * установок лимитов нет вовсе, и платить за это запросом на каждый вызов незачем.
   */
  async listRules(subjects: LimitSubjects): Promise<LimitRuleRow[]> {
    const conditions: SQL[] = [];
    if (subjects.clientId !== undefined) {
      conditions.push(eq(limitRules.clientId, subjects.clientId));
    }
    if (subjects.channelId !== undefined) {
      conditions.push(eq(limitRules.channelId, subjects.channelId));
    }
    if (subjects.partnerIds !== undefined && subjects.partnerIds.length > 0) {
      conditions.push(inArray(limitRules.partnerId, [...subjects.partnerIds]));
    }
    if (subjects.simCardIds !== undefined && subjects.simCardIds.length > 0) {
      conditions.push(inArray(limitRules.simCardId, [...subjects.simCardIds]));
    }
    if (subjects.tariffIds !== undefined && subjects.tariffIds.length > 0) {
      conditions.push(inArray(limitRules.tariffId, [...subjects.tariffIds]));
    }
    if (conditions.length === 0) return [];

    return this.db
      .select()
      .from(limitRules)
      .where(or(...conditions))
      .orderBy(asc(limitRules.window));
  }

  /**
   * Израсходованное по каждому правилу за его текущее окно.
   *
   * Пары «правило и начало окна» перечисляются явно: выбрать по одному правилу без окна
   * значило бы вычитать всю его историю — при часовом окне это тысячи строк за квартал.
   */
  /**
   * Израсходованное в текущих окнах правил — **по всем картам** у правил «на каждую
   * карту»: ключ здесь правило и начало окна, а SIM приходит строкой ответа.
   */
  async listUsage(
    keys: readonly { ruleId: LimitRuleId; bucketStart: Date }[],
  ): Promise<CounterAmount[]> {
    if (keys.length === 0) return [];

    return this.db
      .select({
        ruleId: limitCounters.limitRuleId,
        simCardId: limitCounters.simCardId,
        amount: limitCounters.amount,
      })
      .from(limitCounters)
      .where(
        or(
          ...keys.map((key) =>
            and(
              eq(limitCounters.limitRuleId, key.ruleId),
              eq(limitCounters.bucketStart, key.bucketStart),
            ),
          ),
        ),
      );
  }

  /**
   * Увеличивает счётчики и возвращает новые суммы — ключом `counterKeyOf`.
   *
   * Ключ уникальности — правило, SIM и окно, `NULLS NOT DISTINCT`: у правила без SIM
   * счётчик один, а не по строке на каждый вызов.
   */
  async increase(
    entries: readonly { key: CounterKey; delta: number }[],
    executor: Executor,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();

    for (const entry of entries) {
      if (entry.delta === 0) continue;
      try {
        const [row] = await executor
          .insert(limitCounters)
          .values({
            id: newId<'limitCounter'>(),
            limitRuleId: entry.key.ruleId,
            simCardId: entry.key.simCardId,
            bucketStart: entry.key.bucketStart,
            amount: entry.delta,
          })
          .onConflictDoUpdate({
            target: [limitCounters.limitRuleId, limitCounters.simCardId, limitCounters.bucketStart],
            set: {
              amount: sql`${limitCounters.amount} + ${entry.delta}`,
              updatedAt: new Date(),
            },
          })
          .returning({ amount: limitCounters.amount });

        if (row !== undefined) {
          result.set(counterKeyOf(entry.key.ruleId, entry.key.simCardId), row.amount);
        }
      } catch (cause) {
        throw toDatabaseError(cause);
      }
    }

    return result;
  }

  // --- Ведение правил ------------------------------------------------------------

  async insertRule(draft: {
    clientId: Id<'client'> | null;
    channelId: Id<'channel'> | null;
    partnerId: Id<'partner'> | null;
    simCardId: Id<'simCard'> | null;
    tariffId: Id<'partnerTariff'> | null;
    window: LimitWindow;
    metric: LimitMetric;
    value: number;
    perSim: boolean;
    rounding: LimitRounding;
    periodStartDay: number | null;
    setBy: LimitSetBy;
  }): Promise<LimitRuleRow> {
    try {
      const [row] = await this.db
        .insert(limitRules)
        .values({ id: newId<'limitRule'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findRule(id: LimitRuleId): Promise<LimitRuleRow | undefined> {
    const [row] = await this.db.select().from(limitRules).where(eq(limitRules.id, id));
    return row;
  }

  /**
   * Меняет предел, не трогая счётчик.
   *
   * Именно так, а не «удалить и завести заново»: квота изменилась, а израсходованное
   * никуда не делось. Удаление правила счётчик уносит — это и есть способ обнулить.
   */
  async updateRule(
    id: LimitRuleId,
    change: {
      value: number;
      rounding?: LimitRounding | undefined;
      periodStartDay?: number | null | undefined;
    },
  ): Promise<LimitRuleRow | undefined> {
    try {
      const [row] = await this.db
        .update(limitRules)
        .set(change)
        .where(eq(limitRules.id, id))
        .returning();
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async deleteRule(id: LimitRuleId): Promise<LimitRuleRow | undefined> {
    const [row] = await this.db.delete(limitRules).where(eq(limitRules.id, id)).returning();
    return row;
  }

  /** Лимиты одного субъекта. Без субъекта — все, для обзора у администратора. */
  async listRulesOf(subject: LimitSubjects): Promise<LimitRuleRow[]> {
    const hasSubject =
      subject.clientId !== undefined ||
      subject.channelId !== undefined ||
      (subject.partnerIds?.length ?? 0) > 0 ||
      (subject.simCardIds?.length ?? 0) > 0 ||
      (subject.tariffIds?.length ?? 0) > 0;

    if (!hasSubject) {
      return this.db.select().from(limitRules).orderBy(asc(limitRules.createdAt));
    }
    return this.listRules(subject);
  }

  /**
   * Убирает счётчики закрытых окон.
   *
   * Догоняюще по сроку, а не «с прошлого запуска» ([ADR-0020](../../../../../docs/adr/0020-fonovye-zadachi.md)):
   * пропущенный тик не теряет работу, а два экземпляра воркера не мешают друг другу.
   * Короткие окна (минута, час) — старше `shortBefore`, прочие — старше `before`:
   * минутные окна за квартал дали бы миллионы строк (ADR-0057).
   */
  async deleteCountersBefore(before: Date, shortBefore: Date): Promise<number> {
    const short = sql`${limitCounters.limitRuleId} in (select id from ${limitRules} where ${inArray(limitRules.window, [...SHORT_WINDOWS])})`;
    const removed = await this.db
      .delete(limitCounters)
      .where(
        or(
          lt(limitCounters.bucketStart, before),
          and(lt(limitCounters.bucketStart, shortBefore), short),
        ),
      )
      .returning({ id: limitCounters.id });
    return removed.length;
  }
}
