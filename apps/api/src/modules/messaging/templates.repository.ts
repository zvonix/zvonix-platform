/**
 * Шаблон сообщения клиента ([ADR-0087](../../../../../docs/adr/0087-konstruktor-soobshcheniya.md)).
 */

import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { messageTemplates } from '@zvonix/db/schema';
import { newId, type Id, type TemplateBlock } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

@Injectable()
export class TemplatesRepository {
  constructor(private readonly database: DatabaseService) {}

  async find(clientId: Id<'client'>): Promise<TemplateBlock[] | undefined> {
    const [row] = await this.database.db
      .select({ blocks: messageTemplates.blocks })
      .from(messageTemplates)
      .where(eq(messageTemplates.clientId, clientId));
    return row?.blocks;
  }

  /** Один шаблон на клиента: повторная запись заменяет прежний. */
  async save(clientId: Id<'client'>, blocks: TemplateBlock[]): Promise<void> {
    await this.database.db
      .insert(messageTemplates)
      .values({ id: newId<'messageTemplate'>(), clientId, blocks })
      .onConflictDoUpdate({
        target: messageTemplates.clientId,
        set: { blocks, updatedAt: new Date() },
      });
  }
}
