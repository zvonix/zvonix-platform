/**
 * Приоритеты партнёров у клиента — кабинет клиента
 * ([ADR-0081](../../../../../docs/adr/0081-prioritety-partnyorov-u-klienta.md)). Клиент берётся из сессии.
 */

import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { validationFailed, type ClientPriorityOffer } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import { clientPrioritiesSchema, productSchema } from './priorities.schemas.js';
import {
  PrioritiesService,
  type ClientPriorityView,
  type PriorityProduct,
} from './priorities.service.js';

interface PriorityResponse {
  readonly alias_id: string;
  readonly display_name: string;
  readonly offer: ClientPriorityOffer;
  readonly priority: number | null;
}

@Controller()
export class PrioritiesController {
  constructor(
    private readonly priorities: PrioritiesService,
    private readonly billing: BillingService,
  ) {}

  /** Список клиента: `product` — `calls` (SIM и транк) или `messages` (MAX). Нет строки — партнёр после всех. */
  @Cabinets('client')
  @Get('client/partner-priorities')
  async list(
    @CurrentUser() actor: Principal,
    @Query('product') product?: string,
  ): Promise<{ priorities: PriorityResponse[] }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    return { priorities: (await this.priorities.list(client.id, parse(product))).map(toView) };
  }

  /** Заменяет список целиком; `priority: null` — «не использовать». */
  @Cabinets('client')
  @Put('client/partner-priorities')
  async replace(
    @CurrentUser() actor: Principal,
    @Body(zodBody(clientPrioritiesSchema)) body: z.infer<typeof clientPrioritiesSchema>,
    @Query('product') product?: string,
  ): Promise<{ priorities: PriorityResponse[] }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const rows = await this.priorities.replace(
      { userId: actor.userId, role: actor.role },
      client.id,
      parse(product),
      body.priorities,
    );
    return { priorities: rows.map(toView) };
  }
}

function parse(product: string | undefined): PriorityProduct {
  const parsed = productSchema.safeParse(product);
  if (!parsed.success) throw validationFailed('Укажите список: calls или messages');
  return parsed.data;
}

function toView(row: ClientPriorityView): PriorityResponse {
  return {
    alias_id: row.aliasId,
    display_name: row.displayName,
    offer: row.offer,
    priority: row.priority,
  };
}
