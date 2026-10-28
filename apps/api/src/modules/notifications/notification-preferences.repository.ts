/** Хранилище выбора писем ([ADR-0104](../../../../../docs/adr/0104-pisma-nastraivaet-sam-poluchatel.md)). */

import { Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { toDatabaseError } from '@zvonix/db';
import { notificationPreferences } from '@zvonix/db/schema';
import { newId, type Id } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;

type Choice = Omit<NotificationPreferenceRow, 'id' | 'userId' | 'createdAt' | 'updatedAt'>;

@Injectable()
export class NotificationPreferencesRepository {
  constructor(private readonly database: DatabaseService) {}

  async findMany(userIds: readonly Id<'user'>[]): Promise<NotificationPreferenceRow[]> {
    if (userIds.length === 0) return [];
    return this.database.db
      .select()
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.userId, [...new Set(userIds)]));
  }

  /**
   * Записывает выбор: строки не было — заводится целиком (`initial`), была — меняется только `changes`. Одним
   * оператором, чтобы два одновременных изменения разных писем не затёрли друг друга.
   */
  async upsert(userId: Id<'user'>, initial: Choice, changes: Partial<Choice>): Promise<void> {
    try {
      await this.database.db
        .insert(notificationPreferences)
        .values({ id: newId<'notificationPreference'>(), userId, ...initial, ...changes })
        .onConflictDoUpdate({
          target: notificationPreferences.userId,
          set: { ...changes, updatedAt: new Date() },
        });
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }
}
