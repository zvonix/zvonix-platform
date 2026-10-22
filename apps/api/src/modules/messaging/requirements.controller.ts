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
import { SettingsService } from '../settings/settings.service.js';
import { MessagingService } from './messaging.service.js';
import {
  RequirementsService,
  type AccountOfferView,
  type DeliveryView,
  type RequirementsView,
} from './requirements.service.js';
import { deliverySchema, exclusionSchema, requirementsSchema } from './schemas.js';

@Controller()
export class RequirementsController {
  constructor(
    private readonly requirements: RequirementsService,
    private readonly billing: BillingService,
    private readonly messaging: MessagingService,
    private readonly settings: SettingsService,
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

  /** «Если отправить сразу нельзя» и «сколько ждать» (ADR-0097). */
  @Cabinets('client')
  @Get('client/messages/delivery')
  async delivery(
    @CurrentUser() actor: Principal,
  ): Promise<{ delivery: DeliveryView; platform_max_wait_minutes: number }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const [delivery, { maxWaitMinutes }] = await Promise.all([
      this.requirements.delivery(client.id),
      this.settings.messaging(),
    ]);
    // Значение площадки — чтобы кабинет показал, сколько ждёт «по умолчанию».
    return { delivery, platform_max_wait_minutes: maxWaitMinutes };
  }

  @Cabinets('client')
  @Put('client/messages/delivery')
  async setDelivery(
    @CurrentUser() actor: Principal,
    @Body(zodBody(deliverySchema)) body: z.infer<typeof deliverySchema>,
  ): Promise<{ delivery: DeliveryView }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const delivery = await this.requirements.setDelivery(
      { userId: actor.userId, role: actor.role },
      client.id,
      body,
    );
    return { delivery };
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
