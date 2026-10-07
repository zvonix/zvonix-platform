/**
 * Учётные записи SMPP клиентов ([ADR-0072](../../../../../../docs/adr/0072-smpp-dlya-soobscheniy.md)).
 */

import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { toDatabaseError } from '@zvonix/db';
import { smppAccounts } from '@zvonix/db/schema';
import { newId, type Id, type SmppReceiptAction } from '@zvonix/shared';
import { DatabaseService } from '../../../infra/database.service.js';

export type SmppAccountRow = typeof smppAccounts.$inferSelect;

@Injectable()
export class SmppRepository {
  constructor(private readonly database: DatabaseService) {}

  async findByClient(clientId: Id<'client'>): Promise<SmppAccountRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(smppAccounts)
      .where(eq(smppAccounts.clientId, clientId));
    return row;
  }

  /** Все учётные записи SMPP — сотрудникам: кто подключён, когда заходил последний раз. */
  list(): Promise<SmppAccountRow[]> {
    return this.database.db.select().from(smppAccounts).orderBy(desc(smppAccounts.createdAt));
  }

  async findBySystemId(systemId: string): Promise<SmppAccountRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(smppAccounts)
      .where(eq(smppAccounts.systemId, systemId));
    return row;
  }

  async insert(draft: {
    clientId: Id<'client'>;
    systemId: string;
    passwordHash: string;
  }): Promise<SmppAccountRow> {
    try {
      const [row] = await this.database.db
        .insert(smppAccounts)
        .values({ id: newId<'smppAccount'>(), ...draft })
        .returning();
      if (row === undefined) throw new Error('Учётная запись SMPP не вставлена');
      return row;
    } catch (cause) {
      throw toDatabaseError(cause);
    }
  }

  async update(
    clientId: Id<'client'>,
    patch: {
      passwordHash?: string;
      enabled?: boolean;
      allowedIps?: string[];
      receiptOnSent?: SmppReceiptAction;
      receiptOnDelivered?: SmppReceiptAction;
      receiptOnRead?: SmppReceiptAction;
    },
  ): Promise<SmppAccountRow | undefined> {
    const [row] = await this.database.db
      .update(smppAccounts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(smppAccounts.clientId, clientId))
      .returning();
    return row;
  }

  async touchBind(id: SmppAccountRow['id'], at: Date): Promise<void> {
    await this.database.db
      .update(smppAccounts)
      .set({ lastBindAt: at })
      .where(eq(smppAccounts.id, id));
  }
}
