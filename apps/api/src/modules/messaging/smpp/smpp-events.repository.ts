/**
 * Журнал подключения SMPP ([ADR-0096](../../../../../../docs/adr/0096-zhurnal-podklyucheniy-smpp.md)): входы и отказы в приёме.
 */

import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { clients, smppAccounts, smppEvents } from '@zvonix/db/schema';
import { newId, type SmppBindMode, type SmppEventKind } from '@zvonix/shared';
import { DatabaseService } from '../../../infra/database.service.js';
import type { SmppAccountRow } from './smpp.repository.js';

export type SmppEventRow = typeof smppEvents.$inferSelect;

/** Одинаковые события ближе этого схлопываются в одну строку: программа, повторяющая отказ, не заливает журнал. */
const COLLAPSE_MS = 60_000;

@Injectable()
export class SmppEventsRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Пишет событие. Такое же (подключение, вид, итог, адрес, режим) за последнюю минуту — счётчик у той строки, а не новая.
   * Одним выражением в базе, без памяти процесса: схлопывание работает и при нескольких экземплярах API.
   */
  async record(
    event: {
      accountId: SmppAccountRow['id'] | null;
      /** Введённое имя — только у строк без подключения. */
      systemId: string | null;
      kind: SmppEventKind;
      result: string;
      ip: string;
      mode: SmppBindMode | null;
    },
    at: Date,
  ): Promise<void> {
    const recent = new Date(at.getTime() - COLLAPSE_MS);
    const bumped = await this.database.db
      .update(smppEvents)
      .set({ count: sql`${smppEvents.count} + 1`, lastAt: at })
      .where(
        eq(
          smppEvents.id,
          sql`(select id from ${smppEvents} where ${and(
            event.accountId === null
              ? and(isNull(smppEvents.accountId), eq(smppEvents.systemId, event.systemId ?? ''))
              : eq(smppEvents.accountId, event.accountId),
            eq(smppEvents.kind, event.kind),
            eq(smppEvents.result, event.result),
            eq(smppEvents.ip, event.ip),
            event.mode === null ? sql`${smppEvents.mode} is null` : eq(smppEvents.mode, event.mode),
            gte(smppEvents.lastAt, recent),
          )} order by ${smppEvents.lastAt} desc limit 1)`,
        ),
      )
      .returning({ id: smppEvents.id });
    if (bumped.length > 0) return;
    await this.database.db
      .insert(smppEvents)
      .values({ id: newId<'smppEvent'>(), ...event, createdAt: at, lastAt: at });
  }

  /** Последние события подключения, новые сверху. */
  async list(accountId: SmppAccountRow['id'], limit: number): Promise<SmppEventRow[]> {
    return this.database.db
      .select()
      .from(smppEvents)
      .where(eq(smppEvents.accountId, accountId))
      .orderBy(desc(smppEvents.lastAt))
      .limit(limit);
  }

  /** Журнал площадки: все события, новые сверху, с клиентом подключения (у строк без подключения — пусто). */
  async listAll(limit: number): Promise<(SmppEventRow & { clientName: string | null })[]> {
    const rows = await this.database.db
      .select({ event: smppEvents, clientName: clients.name })
      .from(smppEvents)
      .leftJoin(smppAccounts, eq(smppAccounts.id, smppEvents.accountId))
      .leftJoin(clients, eq(clients.id, smppAccounts.clientId))
      .orderBy(desc(smppEvents.lastAt))
      .limit(limit);
    return rows.map((row) => ({ ...row.event, clientName: row.clientName }));
  }

  /** Стирает события старше срока; возвращает, сколько. */
  async purge(before: Date): Promise<number> {
    const removed = await this.database.db
      .delete(smppEvents)
      .where(lt(smppEvents.lastAt, before))
      .returning({ id: smppEvents.id });
    return removed.length;
  }
}
