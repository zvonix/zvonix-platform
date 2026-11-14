/**
 * Маршруты клиента и его порядок по ним — отдельные SIM и SIP-провайдеры партнёров
 * ([ADR-0120](../../../../../docs/adr/0120-poryadok-otdelnyh-sim-i-sip-u-klienta.md)).
 *
 * Клиент видит партнёра только псевдонимом, а маршрут — номером внутри партнёра (ADR-0014): ни номера карты,
 * ни имени и адреса провайдера сюда не попадает.
 */

import { Injectable } from '@nestjs/common';
import {
  notFound,
  REFERENCE_CALL_SECONDS,
  validationFailed,
  type Id,
  type MoneyAmount,
  type TerminationKind,
  type UserRole,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import { BillingService } from '../billing/billing.service.js';
import { TariffService } from '../catalog/tariff.service.js';
import {
  RoutePrioritiesRepository,
  type RoutePriorityEntry,
  type RouteRow,
} from './route-priorities.repository.js';

export interface ClientRouteView {
  readonly routeId: string;
  readonly kind: TerminationKind;
  readonly aliasId: Id<'partnerAlias'>;
  readonly displayName: string;
  /** Номер внутри партнёра: «SIM 4», «SIP 2». */
  readonly number: number;
  readonly minPrice: MoneyAmount;
  readonly maxPrice: MoneyAmount;
  readonly directions: number;
  readonly listensToRecordings: boolean;
  readonly available: boolean;
  readonly createdAt: Date;
  /** Есть ли у маршрута своя строка; нет — действует цифра предложения. */
  readonly configured: boolean;
  /** Своя цифра; `null` при `configured` — «не использовать». */
  readonly priority: number | null;
}

export interface RoutePriorityInput {
  readonly routeId: string;
  readonly kind: TerminationKind;
  readonly priority: number | null;
}

const keyOf = (kind: TerminationKind, id: string): string => `${kind}:${id}`;

@Injectable()
export class ClientRoutesService {
  constructor(
    private readonly repository: RoutePrioritiesRepository,
    private readonly billing: BillingService,
    private readonly tariffs: TariffService,
    private readonly audit: AuditService,
  ) {}

  /** Маршруты партнёров, предложенных клиенту, у которых есть цена; с его цифрами. */
  async list(userId: Id<'user'>, clientId: Id<'client'>): Promise<ClientRouteView[]> {
    const { routes, aliases } = await this.offeredRoutes(userId);
    const prices = await this.tariffs.routePrices(
      clientId,
      routes.map((route) => ({
        partnerId: route.partnerId,
        tariffId: route.tariffId,
        terminationKind: route.kind,
      })),
      REFERENCE_CALL_SECONDS,
      new Date(),
    );
    const stored = new Map(
      (await this.repository.list(clientId)).map((row) => [
        row.simCardId === null ? keyOf('sip', String(row.gatewayId)) : keyOf('sim', row.simCardId),
        row.priority,
      ]),
    );

    return routes.flatMap((route, index) => {
      const price = prices[index];
      const alias = aliases.get(route.partnerId);
      // Без цены маршрут вызова не получит (ADR-0040), а без псевдонима клиенту непредставим (ADR-0014).
      if (price === undefined || alias === undefined) return [];
      const key = keyOf(route.kind, route.id);
      return [
        {
          routeId: route.id,
          kind: route.kind,
          aliasId: alias.id,
          displayName: alias.displayName,
          number: route.number,
          minPrice: price.minPrice,
          maxPrice: price.maxPrice,
          directions: price.directions,
          listensToRecordings: alias.listensToRecordings,
          available: route.available,
          createdAt: route.createdAt,
          configured: stored.has(key),
          priority: stored.get(key) ?? null,
        },
      ];
    });
  }

  /** Заменяет строки маршрутов целиком; маршрута нет в списке — действует цифра его предложения. */
  async replace(
    actor: { userId: Id<'user'>; role: UserRole },
    clientId: Id<'client'>,
    entries: readonly RoutePriorityInput[],
  ): Promise<ClientRouteView[]> {
    const { routes } = await this.offeredRoutes(actor.userId);
    const known = new Set(routes.map((route) => keyOf(route.kind, route.id)));
    const seen = new Set<string>();
    const resolved: RoutePriorityEntry[] = [];
    for (const entry of entries) {
      const key = keyOf(entry.kind, entry.routeId);
      if (seen.has(key)) throw validationFailed('Один и тот же маршрут указан дважды');
      seen.add(key);
      // Чужой, выведенный и несуществующий маршрут выглядят одинаково: по разнице ответов их не перебрать.
      if (!known.has(key)) throw notFound('Маршрут не найден');
      resolved.push({
        simCardId: entry.kind === 'sim' ? (entry.routeId as Id<'simCard'>) : null,
        gatewayId: entry.kind === 'sip' ? (entry.routeId as Id<'gateway'>) : null,
        priority: entry.priority,
      });
    }

    const before = await this.repository.list(clientId);
    await this.repository.replace(clientId, resolved);
    await this.audit.record({
      action: 'client_route_priorities.set',
      entityType: 'client',
      entityId: clientId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { count: before.length },
      after: { count: resolved.length },
    });
    return this.list(actor.userId, clientId);
  }

  /** Свой партнёр клиенту не предлагается (ADR-0052) — и его карты тоже. */
  private async offeredRoutes(userId: Id<'user'>): Promise<{
    routes: RouteRow[];
    aliases: Map<string, Awaited<ReturnType<BillingService['listOfferedAliases']>>[number]>;
  }> {
    const offered = await this.billing.listOfferedAliases(userId);
    const aliases = new Map(offered.map((alias) => [alias.partnerId, alias]));
    const routes = await this.repository.listRoutes(offered.map((alias) => alias.partnerId));
    return { routes, aliases };
  }
}
