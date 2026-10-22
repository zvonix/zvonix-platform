/**
 * «Аккаунты MAX» клиента ([ADR-0092](../../../../../docs/adr/0092-trebovaniya-klienta-k-akkauntam.md)): требования к аккаунтам,
 * какие аккаунты подходят и ручное отключение. Клиент выводится из сессии — чужой идентификатор подставить некуда.
 */

import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import { MessagingService } from './messaging.service.js';
import {
  RequirementsService,
  type AccountOfferView,
  type RequirementsView,
} from './requirements.service.js';
import { exclusionSchema, requirementsSchema } from './schemas.js';

@Controller()
export class RequirementsController {
  constructor(
    private readonly requirements: RequirementsService,
    private readonly billing: BillingService,
    private readonly messaging: MessagingService,
  ) {}

  @Cabinets('client')
  @Get('client/messages/accounts')
  async accounts(@CurrentUser() actor: Principal): Promise<{
    enabled: boolean;
    requirements: RequirementsView;
    accounts: AccountOfferView[];
  }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const enabled = await this.messaging.isEnabled();
    if (!enabled) {
      return { enabled, requirements: await this.requirements.get(client.id), accounts: [] };
    }
    return { enabled, ...(await this.requirements.accounts(client.id)) };
  }

  @Cabinets('client')
  @Put('client/messages/requirements')
  async setRequirements(
    @CurrentUser() actor: Principal,
    @Body(zodBody(requirementsSchema)) body: z.infer<typeof requirementsSchema>,
  ): Promise<{ requirements: RequirementsView }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const requirements = await this.requirements.set(
      { userId: actor.userId, role: actor.role },
      client.id,
      body,
    );
    return { requirements };
  }

  @Cabinets('client')
  @Put('client/messages/accounts/:id/exclusion')
  async setExclusion(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(exclusionSchema)) body: z.infer<typeof exclusionSchema>,
  ): Promise<{ excluded: boolean }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    await this.requirements.setExclusion(
      { userId: actor.userId, role: actor.role },
      client.id,
      parseId(id, 'messengerAccount'),
      body.excluded,
    );
    return { excluded: body.excluded };
  }
}
