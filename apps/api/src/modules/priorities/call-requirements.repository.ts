/**
 * Требования клиента к партнёрам для звонков
 * ([ADR-0095](../../../../../docs/adr/0095-trebovaniya-klienta-k-partnyoram-zvonkov.md)).
 */

import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { clientCallRequirements } from '@zvonix/db/schema';
import { newId, type Id, type MoneyAmount, type TerminationKind } from '@zvonix/shared';
import { DatabaseService } from '../../infra/database.service.js';

export interface CallRequirementsInput {
  readonly terminationKind: TerminationKind | null;
  readonly noRecordingListeners: boolean;
  readonly maxPrice: MoneyAmount | null;
}

@Injectable()
export class CallRequirementsRepository {
  constructor(private readonly database: DatabaseService) {}

  async find(clientId: Id<'client'>): Promise<CallRequirementsInput | undefined> {
    const [row] = await this.database.db
      .select({
        terminationKind: clientCallRequirements.terminationKind,
        noRecordingListeners: clientCallRequirements.noRecordingListeners,
        maxPrice: clientCallRequirements.maxPrice,
      })
      .from(clientCallRequirements)
      .where(eq(clientCallRequirements.clientId, clientId));
    return row;
  }

  async save(clientId: Id<'client'>, input: CallRequirementsInput): Promise<void> {
    const values = { ...input, updatedAt: new Date() };
    await this.database.db
      .insert(clientCallRequirements)
      .values({ id: newId<'clientCallRequirements'>(), clientId, ...values })
      .onConflictDoUpdate({ target: clientCallRequirements.clientId, set: values });
  }
}
