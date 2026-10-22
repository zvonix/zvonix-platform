/**
 * Требования клиента к партнёрам для звонков
 * ([ADR-0095](../../../../../docs/adr/0095-trebovaniya-klienta-k-partnyoram-zvonkov.md)): чтение для кабинета и маршрутизации,
 * запись с журналом.
 */

import { Injectable } from '@nestjs/common';
import { Money, type Id, type TerminationKind, type UserRole } from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import {
  CallRequirementsRepository,
  type CallRequirementsInput,
} from './call-requirements.repository.js';

export interface CallRequirementsView {
  readonly termination_kind: TerminationKind | null;
  readonly no_recording_listeners: boolean;
  readonly max_price: string | null;
}

const DEFAULTS: CallRequirementsInput = {
  terminationKind: null,
  noRecordingListeners: false,
  maxPrice: null,
};

const viewOf = (input: CallRequirementsInput): CallRequirementsView => ({
  termination_kind: input.terminationKind,
  no_recording_listeners: input.noRecordingListeners,
  max_price: input.maxPrice === null ? null : Money.format(input.maxPrice),
});

/** Требований нет вовсе — маршрутизация идёт как раньше, без лишних условий и чтения наценки. */
const isEmpty = (input: CallRequirementsInput): boolean =>
  input.terminationKind === null && !input.noRecordingListeners && input.maxPrice === null;

@Injectable()
export class CallRequirementsService {
  constructor(
    private readonly repository: CallRequirementsRepository,
    private readonly audit: AuditService,
  ) {}

  async get(clientId: Id<'client'>): Promise<CallRequirementsView> {
    return viewOf((await this.repository.find(clientId)) ?? DEFAULTS);
  }

  /** Для маршрутизации: `undefined` — требований нет. */
  async forRouting(clientId: Id<'client'>): Promise<CallRequirementsInput | undefined> {
    const found = await this.repository.find(clientId);
    return found === undefined || isEmpty(found) ? undefined : found;
  }

  async set(
    actor: { userId: Id<'user'>; role: UserRole },
    clientId: Id<'client'>,
    input: CallRequirementsInput,
  ): Promise<CallRequirementsView> {
    const before = (await this.repository.find(clientId)) ?? DEFAULTS;
    await this.repository.save(clientId, input);
    await this.audit.record({
      action: 'client_call_requirements.set',
      entityType: 'client',
      entityId: clientId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: viewOf(before),
      after: viewOf(input),
    });
    return viewOf(input);
  }
}
