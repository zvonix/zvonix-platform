/**
 * Запросы к чёрному списку номеров (ADR-0024).
 */

import { Injectable } from '@nestjs/common';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { toDatabaseError, type Database } from '@zvonix/db';
import { blockedNumbers } from '@zvonix/db/schema';
import { newId, type Id, type Msisdn } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';
import { blockingPrefixesOf } from './blocked-numbers.js';

export type BlockedNumberId = Id<'blockedNumber'>;
export type BlockedNumberRow = typeof blockedNumbers.$inferSelect;

@Injectable()
export class BlockedNumberRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db(): Database {
    return this.database.db;
  }

  /**
   * Правило, под которое подпадает номер, если оно есть.
   *
   * Ищутся **префиксы номера среди правил**, а не правила, подходящие к номеру: первое —
   * восемь значений в `IN` по уникальному индексу, второе — перебор таблицы с `like`
   * на каждый вызов.
   *
   * Из нескольких подошедших возвращается самое длинное: оно точнее описывает причину,
   * а показать человеку общий запрет вместо частного значит отправить его искать не там.
   */
  async findMatching(destination: Msisdn): Promise<BlockedNumberRow | undefined> {
    const prefixes = blockingPrefixesOf(destination);
    if (prefixes.length === 0) return undefined;

    const [row] = await this.db
      .select()
      .from(blockedNumbers)
      .where(inArray(blockedNumbers.prefix, prefixes))
      // Самое длинное из подошедших: оно точнее описывает причину, а показать человеку
      // общий запрет вместо частного значит отправить его искать не там.
      .orderBy(sql`length(${blockedNumbers.prefix}) desc`)
      .limit(1);

    return row;
  }

  async insert(draft: { prefix: string; note: string }): Promise<BlockedNumberRow> {
    try {
      const [row] = await this.db
        .insert(blockedNumbers)
        .values({ id: newId<'blockedNumber'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Вставка не вернула строку');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async list(): Promise<BlockedNumberRow[]> {
    return this.db.select().from(blockedNumbers).orderBy(asc(blockedNumbers.prefix));
  }

  async find(id: BlockedNumberId): Promise<BlockedNumberRow | undefined> {
    const [row] = await this.db.select().from(blockedNumbers).where(eq(blockedNumbers.id, id));
    return row;
  }

  async remove(id: BlockedNumberId): Promise<BlockedNumberRow | undefined> {
    const [row] = await this.db.delete(blockedNumbers).where(eq(blockedNumbers.id, id)).returning();
    return row;
  }
}
