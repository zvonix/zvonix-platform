/**
 * Записи тестовых звонков с SIM ([ADR-0055](../../../../../docs/adr/0055-testovyy-zvonok-s-sim.md)) и через SIP-транк
 * ([ADR-0100](../../../../../docs/adr/0100-sip-provayder-partnyora-i-vklyuchenie-posle-proby.md)).
 */

import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, lt, type SQL } from 'drizzle-orm';
import { toDatabaseError, type Database, type Executor } from '@zvonix/db';
import { testCalls } from '@zvonix/db/schema';
import { newId, type Id, type TestCallStatus } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type TestCallId = Id<'testCall'>;
export type TestCallRow = typeof testCalls.$inferSelect;

export interface TestCallDraft {
  /** Пусто — проба транка: карты и порта у него нет. */
  readonly simCardId: Id<'simCard'> | null;
  readonly partnerId: Id<'partner'>;
  readonly gatewayId: Id<'gateway'>;
  readonly portNumber: number | null;
  readonly nodeId: Id<'node'>;
  readonly destination: string;
  readonly sipUsername: string;
  readonly requestedBy: Id<'user'>;
}

/** Чья проба: карты или транка (у транка карты нет). */
export type TestCallSubject =
  { readonly simCardId: Id<'simCard'> } | { readonly trunkId: Id<'gateway'> };

function subjectFilter(subject: TestCallSubject): SQL | undefined {
  return 'simCardId' in subject
    ? eq(testCalls.simCardId, subject.simCardId)
    : and(eq(testCalls.gatewayId, subject.trunkId), isNull(testCalls.simCardId));
}

/** Итог, дописываемый к пробе: из ответа ESL или из CDR. */
export interface TestCallOutcome {
  readonly status?: Exclude<TestCallStatus, 'dialing'>;
  readonly hangupCause?: string | null;
  readonly sipStatus?: string | null;
  readonly talkSeconds?: number | null;
  readonly sipPhrase?: string | null;
  readonly rangAt?: Date | null;
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

  /** Последняя проба карты или транка — по ней видно, идёт ли уже проба. */
  async lastFor(
    subject: TestCallSubject,
    executor: Executor = this.db,
  ): Promise<TestCallRow | undefined> {
    const [row] = await executor
      .select()
      .from(testCalls)
      .where(subjectFilter(subject))
      .orderBy(desc(testCalls.createdAt))
      .limit(1);
    return row;
  }

  /**
   * Закрывает пробы карты или транка, чей итог потерян: процесс площадки перезапустился посреди
   * звонка, а CDR не пришёл. Иначе висящая `dialing` навсегда запирала бы её
   * уникальным индексом «одна проба одновременно».
   */
  async expireStale(
    subject: TestCallSubject,
    startedBefore: Date,
    executor: Executor = this.db,
  ): Promise<void> {
    await executor
      .update(testCalls)
      .set({ status: 'unknown', finishedAt: new Date() })
      .where(
        and(
          subjectFilter(subject),
          eq(testCalls.status, 'dialing'),
          lt(testCalls.createdAt, startedBefore),
        ),
      );
  }

  /**
   * Была ли отвеченная проба позже `after` (ADR-0100): у карты — с неё самой, у шлюза — с любой его карты или с самого
   * транка. По ней партнёр включает отключённое автоматом.
   */
  async answeredAfter(
    subject: { readonly simCardId: Id<'simCard'> } | { readonly gatewayId: Id<'gateway'> },
    after: Date,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: testCalls.id })
      .from(testCalls)
      .where(
        and(
          'simCardId' in subject
            ? eq(testCalls.simCardId, subject.simCardId)
            : eq(testCalls.gatewayId, subject.gatewayId),
          eq(testCalls.status, 'answered'),
          gt(testCalls.createdAt, after),
        ),
      )
      .limit(1);
    return row !== undefined;
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
      ...(outcome.sipPhrase === undefined ? {} : { sipPhrase: outcome.sipPhrase }),
      ...(outcome.rangAt === undefined ? {} : { rangAt: outcome.rangAt }),
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
