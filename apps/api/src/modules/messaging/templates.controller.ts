/**
 * Шаблон сообщения в кабинете клиента ([ADR-0087](../../../../../docs/adr/0087-konstruktor-soobshcheniya.md)).
 */

import { Body, Controller, Get, Put } from '@nestjs/common';
import type { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import { templateSchema } from './schemas.js';
import { TemplatesService } from './templates.service.js';
import type { TemplateBlock } from '@zvonix/shared';

@Controller()
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly billing: BillingService,
  ) {}

  @Cabinets('client')
  @Get('client/messages/template')
  async get(@CurrentUser() actor: Principal): Promise<{ blocks: readonly TemplateBlock[] }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    return { blocks: await this.templates.get(client.id) };
  }

  /** Заменяет шаблон целиком: порядок блоков и есть содержимое. */
  @Cabinets('client')
  @Put('client/messages/template')
  async save(
    @CurrentUser() actor: Principal,
    @Body(zodBody(templateSchema)) body: z.infer<typeof templateSchema>,
  ): Promise<{ blocks: readonly TemplateBlock[] }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    return { blocks: await this.templates.save(client.id, body.blocks) };
  }
}
