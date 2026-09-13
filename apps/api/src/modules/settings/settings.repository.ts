/**
 * Хранилище настроек площадки
 * ([ADR-0031](../../../../../docs/adr/0031-nastroyki-ploshchadki.md)).
 */

import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { toDatabaseError, type Executor } from '@zvonix/db';
import { platformSettings } from '@zvonix/db/schema';
import { newId, type Id } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export type { Executor };

export interface StoredSetting {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: Date;
  readonly updatedByUserId: Id<'user'> | null;
}

@Injectable()
export class SettingsRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Пул: нужен службе, чтобы открыть транзакцию вокруг записи и её журнала. */
  get db() {
    return this.database.db;
  }

  /**
   * Все заданные значения. Незаданные не хранятся вовсе — у них действует умолчание.
   *
   * Исполнитель задаётся снаружи, чтобы «что было до» читалось той же транзакцией,
   * что и запись: иначе между чтением и записью успевает вклиниться чужое изменение,
   * и в журнале окажется предыдущее состояние не того, кто его менял.
   */
  async list(executor: Executor = this.db): Promise<StoredSetting[]> {
    return executor
      .select({
        key: platformSettings.key,
        value: platformSettings.value,
        updatedAt: platformSettings.updatedAt,
        updatedByUserId: platformSettings.updatedByUserId,
      })
      .from(platformSettings);
  }

  /**
   * Записывает значение.
   *
   * `on conflict` по имени: настройка одна на площадку, и две строки с одним именем
   * означали бы, что действующее значение зависит от порядка чтения.
   */
  async put(
    input: { key: string; value: string; updatedByUserId: Id<'user'> | null; at: Date },
    executor: Executor = this.db,
  ): Promise<void> {
    try {
      await executor
        .insert(platformSettings)
        .values({
          id: newId<'platformSetting'>(),
          key: input.key,
          value: input.value,
          updatedByUserId: input.updatedByUserId,
          updatedAt: input.at,
        })
        .onConflictDoUpdate({
          target: platformSettings.key,
          set: {
            value: input.value,
            updatedByUserId: input.updatedByUserId,
            updatedAt: input.at,
          },
        });
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  /** Убирает значение: настройка возвращается к умолчанию. */
  async remove(key: string, executor: Executor = this.db): Promise<void> {
    await executor.delete(platformSettings).where(eq(platformSettings.key, key));
  }
}
