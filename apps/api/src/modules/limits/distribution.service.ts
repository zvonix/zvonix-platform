/**
 * Распределение партнёра ([ADR-0080](../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)): чтение для
 * отбора и запись из кабинета партнёра. Одно место на звонки и сообщения.
 */

import { Injectable } from '@nestjs/common';
import {
  DEFAULT_DISTRIBUTION,
  type DistributionProduct,
  type DistributionSettings,
  type Id,
  type UserRole,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import { DistributionRepository } from './distribution.repository.js';

@Injectable()
export class DistributionService {
  constructor(
    private readonly repository: DistributionRepository,
    private readonly audit: AuditService,
  ) {}

  /** Настройки партнёров для направления; кто ничего не настраивал — «поровну» без параметров. */
  async forPartners(
    partnerIds: readonly Id<'partner'>[],
    product: DistributionProduct,
  ): Promise<Map<string, DistributionSettings>> {
    const rows = await this.repository.forPartners(partnerIds, product);
    const result = new Map<string, DistributionSettings>();
    for (const id of partnerIds) result.set(id, rows.get(id) ?? DEFAULT_DISTRIBUTION);
    return result;
  }

  async get(partnerId: Id<'partner'>, product: DistributionProduct): Promise<DistributionSettings> {
    return (await this.forPartners([partnerId], product)).get(partnerId) ?? DEFAULT_DISTRIBUTION;
  }

  /** Партнёр сохраняет настройку; решение пишется в журнал. */
  async save(
    actor: { userId: Id<'user'>; role: UserRole },
    partnerId: Id<'partner'>,
    product: DistributionProduct,
    values: DistributionSettings,
  ): Promise<DistributionSettings> {
    const before = await this.get(partnerId, product);
    const saved = await this.repository.upsert(partnerId, product, values);
    await this.audit.record({
      action: 'partner_distribution.changed',
      entityType: 'partner',
      entityId: partnerId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { product, mode: before.mode },
      after: { product, mode: saved.mode, reserve_percent: saved.reservePercent },
    });
    return saved;
  }
}
