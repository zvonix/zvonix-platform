/**
 * Маршруты клиента — отдельные SIM и SIP-провайдеры партнёров — и порядок по ним, кабинет клиента
 * ([ADR-0120](../../../../../docs/adr/0120-poryadok-otdelnyh-sim-i-sip-u-klienta.md)). Клиент берётся из сессии.
 */

import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  CLIENT_PRIORITY_MAX,
  Money,
  TERMINATION_KINDS,
  type TerminationKind,
} from '@zvonix/shared';
import { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import { ClientRoutesService, type ClientRouteView } from './client-routes.service.js';

const routePrioritiesSchema = z.object({
  priorities: z
    .array(
      z.object({
        routeId: z.uuid('должен быть идентификатором'),
        kind: z.enum(TERMINATION_KINDS),
        priority: z
          .number()
          .int('должно быть целым числом')
          .min(1, 'от 1')
          .max(CLIENT_PRIORITY_MAX, `до ${String(CLIENT_PRIORITY_MAX)}`)
          .nullable(),
      }),
    )
    .max(20000, 'неправдоподобно много'),
});

interface RouteResponse {
  readonly route_id: string;
  readonly kind: TerminationKind;
  readonly alias_id: string;
  readonly display_name: string;
  readonly number: number;
  readonly min_price: string;
  readonly max_price: string;
  readonly directions: number;
  readonly listens_to_recordings: boolean;
  readonly available: boolean;
  readonly created_at: string;
  readonly configured: boolean;
  readonly priority: number | null;
}

@Controller()
export class ClientRoutesController {
  constructor(
    private readonly routes: ClientRoutesService,
    private readonly billing: BillingService,
  ) {}

  /** Маршруты с ценой эталонного вызова (60 с, с наценкой) и цифрой клиента. */
  @Cabinets('client')
  @Get('client/routes')
  async list(@CurrentUser() actor: Principal): Promise<{ routes: RouteResponse[] }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    return { routes: (await this.routes.list(actor.userId, client.id)).map(toView) };
  }

  /** Заменяет строки маршрутов целиком; `priority: null` — «не использовать», нет строки — цифра предложения. */
  @Cabinets('client')
  @Put('client/route-priorities')
  async replace(
    @CurrentUser() actor: Principal,
    @Body(zodBody(routePrioritiesSchema)) body: z.infer<typeof routePrioritiesSchema>,
  ): Promise<{ routes: RouteResponse[] }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const rows = await this.routes.replace(
      { userId: actor.userId, role: actor.role },
      client.id,
      body.priorities,
    );
    return { routes: rows.map(toView) };
  }
}

function toView(row: ClientRouteView): RouteResponse {
  return {
    route_id: row.routeId,
    kind: row.kind,
    alias_id: row.aliasId,
    display_name: row.displayName,
    number: row.number,
    min_price: Money.format(row.minPrice),
    max_price: Money.format(row.maxPrice),
    directions: row.directions,
    listens_to_recordings: row.listensToRecordings,
    available: row.available,
    created_at: row.createdAt.toISOString(),
    configured: row.configured,
    priority: row.priority,
  };
}
