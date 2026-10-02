/**
 * Запросы к записям разговоров.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { toDatabaseError, type Database } from '@zvonix/db';
import { recordingGrants, recordings } from '@zvonix/db/schema';
import { newId, type Id } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type RecordingRow = typeof recordings.$inferSelect;
export type RecordingGrantRow = typeof recordingGrants.$inferSelect;

@Injectable()
export class RecordingsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db(): Database {
    return this.database.db;
  }

  async insert(draft: {
    callId: Id<'call'>;
    objectKey: string;
    expiresAt: Date;
  }): Promise<RecordingRow> {
    try {
      const [row] = await this.db
        .insert(recordings)
        .values({ id: newId<'recording'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async findById(id: Id<'recording'>): Promise<RecordingRow | undefined> {
    const [row] = await this.db.select().from(recordings).where(eq(recordings.id, id));
    return row;
  }

  async findByCall(callId: Id<'call'>): Promise<RecordingRow | undefined> {
    const [row] = await this.db.select().from(recordings).where(eq(recordings.callId, callId));
    return row;
  }

  /** Выгруженные и ещё не удалённые записи этих вызовов — то, что можно предложить послушать. */
  async findListenable(callIds: readonly Id<'call'>[]): Promise<RecordingRow[]> {
    if (callIds.length === 0) return [];
    return this.db
      .select()
      .from(recordings)
      .where(
        and(
          inArray(recordings.callId, [...callIds]),
          isNotNull(recordings.uploadedAt),
          isNull(recordings.deletedAt),
        ),
      );
  }

  /**
   * Отмечает выгрузку подтверждённой — **условным обновлением** по отсутствию отметки.
   *
   * Узел мог отчитаться дважды. Вторая отметка не должна переписывать момент первой:
   * по нему считается, сколько запись уже хранится.
   */
  async confirmUpload(
    id: Id<'recording'>,
    facts: { durationSeconds: number; sizeBytes: bigint },
    at: Date,
  ): Promise<RecordingRow | undefined> {
    const [row] = await this.db
      .update(recordings)
      .set({ durationSeconds: facts.durationSeconds, sizeBytes: facts.sizeBytes, uploadedAt: at })
      .where(and(eq(recordings.id, id), isNull(recordings.uploadedAt)))
      .returning();
    return row ?? this.findById(id);
  }

  /** Записи, у которых истёк срок хранения и объект ещё не удалён. */
  async findExpired(deadline: Date, limit: number): Promise<RecordingRow[]> {
    return this.db
      .select()
      .from(recordings)
      .where(and(isNull(recordings.deletedAt), lte(recordings.expiresAt, deadline)))
      .orderBy(asc(recordings.expiresAt))
      .limit(limit);
  }

  /** Отметка об удалении. Строка остаётся: по ней видно, что запись была и ушла по сроку. */
  // --- Разовый доступ партнёра (ADR-0036) ---------------------------------------

  /**
   * Действующий доступ партнёра к записи.
   *
   * «Действующий» — не отозванный и не истёкший. Истёкшие строки не удаляются:
   * они часть следа того, кому и когда запись открывали.
   */
  async findLiveGrant(
    recordingId: Id<'recording'>,
    partnerId: Id<'partner'>,
    now: Date,
  ): Promise<RecordingGrantRow | undefined> {
    const [row] = await this.db
      .select()
      .from(recordingGrants)
      .where(
        and(
          eq(recordingGrants.recordingId, recordingId),
          eq(recordingGrants.partnerId, partnerId),
          isNull(recordingGrants.revokedAt),
          gt(recordingGrants.expiresAt, now),
        ),
      )
      .orderBy(desc(recordingGrants.expiresAt))
      .limit(1);
    return row;
  }

  async insertGrant(draft: {
    recordingId: Id<'recording'>;
    partnerId: Id<'partner'>;
    grantedByUserId: Id<'user'>;
    reason: string;
    expiresAt: Date;
  }): Promise<RecordingGrantRow> {
    try {
      const [row] = await this.db
        .insert(recordingGrants)
        .values({ id: newId<'recordingGrant'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /** Отзывает все действующие доступы к записи: доступ открывали ошибочно или он больше не нужен. */
  async revokeGrants(recordingId: Id<'recording'>, at: Date): Promise<number> {
    const revoked = await this.db
      .update(recordingGrants)
      .set({ revokedAt: at })
      .where(
        and(
          eq(recordingGrants.recordingId, recordingId),
          isNull(recordingGrants.revokedAt),
          gt(recordingGrants.expiresAt, at),
        ),
      )
      .returning({ id: recordingGrants.id });
    return revoked.length;
  }

  /** Все выданные доступы к записи — и действующие, и погашенные: это след, а не список прав. */
  async listGrants(recordingId: Id<'recording'>): Promise<RecordingGrantRow[]> {
    return this.db
      .select()
      .from(recordingGrants)
      .where(eq(recordingGrants.recordingId, recordingId))
      .orderBy(desc(recordingGrants.createdAt));
  }

  async markDeleted(id: Id<'recording'>, at: Date): Promise<void> {
    await this.db.update(recordings).set({ deletedAt: at }).where(eq(recordings.id, id));
  }

  /**
   * Клиент, которым владеет учётная запись.
   *
   * Нужен для проверки владения записью: роль `client` сама по себе не говорит,
   * какому клиенту принадлежит человек (ADR-0018).
   */
}
