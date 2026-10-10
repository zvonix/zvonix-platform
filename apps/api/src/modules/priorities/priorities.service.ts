/**
 * Приоритеты партнёров у клиента ([ADR-0081](../../../../../docs/adr/0081-prioritety-partnyorov-u-klienta.md)):
 * чтение для кабинета и выбора аккаунта, запись списка целиком с журналом.
 */

import { Injectable } from '@nestjs/common';
import {
  internal,
  notFound,
  parseId,
  validationFailed,
  type ClientPriorityOffer,
  type Id,
  type UserRole,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import { BillingRepository } from '../billing/billing.repository.js';
import { PrioritiesRepository, type ClientPriorityEntry } from './priorities.repository.js';
import { PRODUCT_OFFERS } from './priorities.schemas.js';

export type PriorityProduct = keyof typeof PRODUCT_OFFERS;

/** Строка списка так, как её видит клиент: только псевдоним партнёра (ADR-0014). */
export interface ClientPriorityView {
  readonly aliasId: Id<'partnerAlias'>;
  readonly displayName: string;
  readonly offer: ClientPriorityOffer;
  readonly priority: number | null;
}

/** Список клиента для выбора аккаунта: цифра партнёра, `null` — не использовать; нет строки — партнёр после всех. */
export interface MessagePriorities {
  readonly byPartner: ReadonlyMap<string, number | null>;
}

@Injectable()
export class PrioritiesService {
  constructor(
    private readonly repository: PrioritiesRepository,
    private readonly billing: BillingRepository,
    private readonly audit: AuditService,
  ) {}

  async list(clientId: Id<'client'>, product: PriorityProduct): Promise<ClientPriorityView[]> {
    const rows = await this.repository.list(clientId, PRODUCT_OFFERS[product]);
    const aliases = await this.billing.listAliasesByPartners(rows.map((row) => row.partnerId));
    const byPartner = new Map(aliases.map((alias) => [alias.partnerId, alias]));
    return rows.map((row) => {
      const alias = byPartner.get(row.partnerId);
      // Партнёр без псевдонима клиенту непредставим (ADR-0014): псевдоним заводится вместе с партнёром.
      if (alias === undefined) throw internal('У партнёра из списка клиента нет псевдонима');
      return {
        aliasId: alias.id,
        displayName: alias.displayName,
        offer: row.offer,
        priority: row.priority,
      };
    });
  }

  /** Список сообщений для выбора аккаунта. */
  async forMessages(clientId: Id<'client'>): Promise<MessagePriorities> {
    const rows = await this.repository.list(clientId, PRODUCT_OFFERS.messages);
    return { byPartner: new Map(rows.map((row) => [row.partnerId, row.priority])) };
  }

  async replace(
    actor: { userId: Id<'user'>; role: UserRole },
    clientId: Id<'client'>,
    product: PriorityProduct,
    entries: readonly { aliasId: string; offer: ClientPriorityOffer; priority: number | null }[],
  ): Promise<ClientPriorityView[]> {
    const allowed: readonly string[] = PRODUCT_OFFERS[product];
    const seen = new Set<string>();
    const resolved: ClientPriorityEntry[] = [];
    for (const entry of entries) {
      if (!allowed.includes(entry.offer)) {
        throw validationFailed('Это предложение не относится к выбранному списку');
      }
      const key = `${entry.aliasId}:${entry.offer}`;
      if (seen.has(key)) throw validationFailed('Одно и то же предложение указано дважды');
      seen.add(key);
      const alias = await this.billing.findAliasById(parseId(entry.aliasId, 'partnerAlias'));
      // Несуществующий и чужой псевдоним выглядят одинаково: по разнице ответов их перебирать нельзя.
      if (alias === undefined) throw notFound('Партнёр не найден');
      resolved.push({ partnerId: alias.partnerId, offer: entry.offer, priority: entry.priority });
    }

    const before = await this.repository.list(clientId, PRODUCT_OFFERS[product]);
    await this.repository.replace(clientId, PRODUCT_OFFERS[product], resolved);
    await this.audit.record({
      action: 'client_partner_priorities.set',
      entityType: 'client',
      entityId: clientId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { product, count: before.length },
      after: { product, count: resolved.length },
    });
    return this.list(clientId, product);
  }
}
