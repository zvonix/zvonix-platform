/**
 * Записи тестовых звонков с SIM ([ADR-0055](../../../../../docs/adr/0055-testovyy-zvonok-s-sim.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { toDatabaseError, type Database, type Executor } from '@zvonix/db';
import { testCalls } from '@zvonix/db/schema';
import { newId, type Id, type TestCallStatus } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type TestCallId = Id<'testCall'>;
export type TestCallRow = typeof testCalls.$inferSelect;

export interface TestCallDraft {
  readonly simCardId: Id<'simCard'>;
  readonly partnerId: Id<'partner'>;
  readonly gatewayId: Id<'gateway'>;
  readonly portNumber: number;
  readonly nodeId: Id<'node'>;
  readonly destination: string;
  readonly sipUsername: string;
  readonly requestedBy: Id<'user'>;
}

/** Итог, дописываемый к пробе: из ответа ESL или из CDR. */
export interface TestCallOutcome {
  readonly status?: Exclude<TestCallStatus, 'dialing'>;
  readonly hangupCause?: string | null;
  readonly sipStatus?: string | null;
  readonly talkSeconds?: number | null;
}

@Injectable()
export class TestCallRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db(): Database {
    return this.database.db;
  }

  async create(draft: TestCallDraft, executor: Executor = this.db): Promise<TestCallRow> {
    try {
      const [row] = await executor
        .insert(testCalls)
        .values({ id: newId<'testCall'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка пробы не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async find(id: TestCallId): Promise<TestCallRow | undefined> {
    const [row] = await this.db.select().from(testCalls).where(eq(testCalls.id, id));
    return row;
  }

  /** Последняя проба карты — по ней держится предел «раз в минуту». */
  async lastForSim(
    simCardId: Id<'simCard'>,
    executor: Executor = this.db,
  ): Promise<TestCallRow | undefined> {
    const [row] = await executor
      .select()
      .from(testCalls)
      .where(eq(testCalls.simCardId, simCardId))
      .orderBy(desc(testCalls.createdAt))
      .limit(1);
    return row;
  }

  /**
   * Закрывает пробы карты, чей итог потерян: процесс площадки перезапустился посреди
   * звонка, а CDR не пришёл. Иначе висящая `dialing` навсегда запирала бы карту
   * уникальным индексом «одна проба одновременно».
   */
  async expireStale(
    simCardId: Id<'simCard'>,
    startedBefore: Date,
    executor: Executor = this.db,
  ): Promise<void> {
    await executor
      .update(testCalls)
      .set({ status: 'unknown', finishedAt: new Date() })
      .where(
        and(
          eq(testCalls.simCardId, simCardId),
          eq(testCalls.status, 'dialing'),
          lt(testCalls.createdAt, startedBefore),
        ),
      );
  }

  /**
   * Дописывает итог.
   *
   * Состояние меняется только у пробы в `dialing`: ответ ESL и CDR приходят в любом
   * порядке, и второй не должен перетереть первый. Длительность и код SIP дописываются
   * всегда — они бывают только в CDR.
   */
  async finish(id: TestCallId, outcome: TestCallOutcome): Promise<TestCallRow | undefined> {
    const details = {
      ...(outcome.sipStatus === undefined ? {} : { sipStatus: outcome.sipStatus }),
      ...(outcome.talkSeconds === undefined ? {} : { talkSeconds: outcome.talkSeconds }),
    };

    if (outcome.status !== undefined) {
      const [closed] = await this.db
        .update(testCalls)
        .set({
          ...details,
          status: outcome.status,
          hangupCause: outcome.hangupCause ?? null,
          finishedAt: new Date(),
        })
        .where(and(eq(testCalls.id, id), eq(testCalls.status, 'dialing')))
        .returning();
      if (closed !== undefined) return closed;
    }

    if (Object.keys(details).length === 0) return this.find(id);
    const [row] = await this.db
      .update(testCalls)
      .set(details)
      .where(eq(testCalls.id, id))
      .returning();
    return row;
  }
}
