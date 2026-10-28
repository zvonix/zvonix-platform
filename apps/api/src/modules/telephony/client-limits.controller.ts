/**
 * Лимиты, которые клиент задаёт себе сам, и часовой пояс аккаунта
 * ([ADR-0102](../../../../../docs/adr/0102-chasovoy-poyas-akkaunta-i-limity.md)).
 *
 * Клиент ограничивает себя или одну линию: звонки, минуты или деньги за час, сутки, неделю, месяц. Это защита
 * от зациклившейся программы и украденного пароля линии — платит за чужие звонки он. Лимиты площадки ему видны,
 * но не меняются. Сутки — в поясе аккаунта; пояс задаёт клиент и партнёр, каждый у себя.
 *
 * Здесь, а не в модуле лимитов: владение линией и пояс клиента знает телефония (как у `PartnerLimitsController`).
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { parseId, permissionDenied, type Id } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { ClientRow } from '../billing/billing.repository.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import type { LimitRuleRow } from '../limits/limit.repository.js';
import { LimitService, type RuleOwner } from '../limits/limit.service.js';
import {
  accountTimezoneSchema,
  changeClientLimitSchema,
  clientLimitSchema,
} from '../limits/schemas.js';
import { toLimitView, toUsageView, type LimitUsageView, type LimitView } from '../limits/views.js';
import { accountTimezone, LimitOwnersService } from './limit-owners.service.js';
import { TelephonyService } from './telephony.service.js';

@Controller()
export class ClientLimitsController {
  constructor(
    private readonly limits: LimitService,
    private readonly owners: LimitOwnersService,
    private readonly telephony: TelephonyService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Свои лимиты и лимиты площадки на себя и свои линии — с израсходованным и моментом обнуления.
   * `timezone` — пояс аккаунта; пусто — не выбран, сутки считаются по UTC.
   */
  @Cabinets('client')
  @Get('client/limits')
  async list(
    @CurrentUser() actor: Principal,
  ): Promise<{ limits: LimitUsageView[]; timezone: string | null }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const channels = await this.telephony.listOpenChannels(client.id);
    const usage = await this.limits.usage(
      { clientId: client.id, channelIds: channels.map((channel) => channel.id) },
      new Date(),
    );
    return { limits: usage.map(toUsageView), timezone: client.timezone };
  }

  @Cabinets('client')
  @Post('client/limits')
  async add(
    @CurrentUser() actor: Principal,
    @Body(zodBody(clientLimitSchema)) body: z.infer<typeof clientLimitSchema>,
  ): Promise<{ limit: LimitView }> {
    const client = await this.editableClient(actor);
    let channelId: Id<'channel'> | null = null;
    if (body.scope === 'channel' && body.channelId !== undefined) {
      channelId = parseId(body.channelId, 'channel');
      // Своя и не удалённая: лимит на удалённую линию ничего не ограничивал бы.
      const own = await this.telephony.listOpenChannels(client.id);
      if (!own.some((channel) => channel.id === channelId)) {
        throw permissionDenied('Линия не найдена');
      }
    }
    const row = await this.limits.add(
      {
        clientId: channelId === null ? client.id : null,
        channelId,
        partnerId: null,
        simCardId: null,
        window: body.window,
        metric: body.metric,
        value: body.value,
        setBy: 'client',
        timezone: accountTimezone(client),
      },
      actor.userId,
      actor.role,
    );
    return { limit: toLimitView(row) };
  }

  @Cabinets('client')
  @Patch('client/limits/:id')
  async change(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(changeClientLimitSchema)) body: z.infer<typeof changeClientLimitSchema>,
  ): Promise<{ limit: LimitView }> {
    const client = await this.editableClient(actor);
    const row = await this.limits.changeRule(
      parseId(id, 'limitRule'),
      body,
      actor,
      await this.ownerCheck(client),
    );
    return { limit: toLimitView(row) };
  }

  /** Удаление уносит и счётчики — так клиент и обнуляет израсходованное по своему правилу. */
  @Cabinets('client')
  @Delete('client/limits/:id')
  @HttpCode(204)
  async remove(@CurrentUser() actor: Principal, @Param('id') id: string): Promise<void> {
    const client = await this.editableClient(actor);
    await this.limits.remove(parseId(id, 'limitRule'), actor, await this.ownerCheck(client));
  }

  /**
   * Часовой пояс клиента: в нём считаются сутки, недели и месяцы его лимитов. Набранное за текущее окно
   * переносится — сменой пояса лимит не обнулить (ADR-0102, п. 3).
   */
  @Cabinets('client')
  @Put('client/account/timezone')
  async setClientTimezone(
    @CurrentUser() actor: Principal,
    @Body(zodBody(accountTimezoneSchema)) body: z.infer<typeof accountTimezoneSchema>,
  ): Promise<{ timezone: string }> {
    const client = await this.editableClient(actor);
    await this.owners.setClientTimezone(client, body.timezone, actor);
    return { timezone: body.timezone };
  }

  /** Часовой пояс партнёра — для окон его лимитов и лимитов его карт и тарифов. */
  @Cabinets('partner')
  @Put('partner/account/timezone')
  async setPartnerTimezone(
    @CurrentUser() actor: Principal,
    @Body(zodBody(accountTimezoneSchema)) body: z.infer<typeof accountTimezoneSchema>,
  ): Promise<{ timezone: string }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    if (partner.status === 'closed') {
      throw permissionDenied('Партнёр закрыт: изменения недоступны');
    }
    await this.owners.setPartnerTimezone(partner, body.timezone, actor);
    return { timezone: body.timezone };
  }

  /** Своё правило — на себя или на свою линию, в том числе удалённую: его можно снять. */
  private async ownerCheck(client: ClientRow): Promise<RuleOwner> {
    const channels = await this.telephony.listChannels(client.id);
    const own = new Set<string>(channels.map((channel) => channel.id));
    return {
      setBy: 'client',
      owns: (rule: LimitRuleRow) =>
        rule.clientId === client.id || (rule.channelId !== null && own.has(rule.channelId)),
    };
  }

  /** Закрытый клиент не меняет ничего: запись осталась бы от участника, которого нет. */
  private async editableClient(actor: Principal): Promise<ClientRow> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    if (client.status === 'closed') {
      throw permissionDenied('Клиент закрыт: изменения недоступны');
    }
    return client;
  }
}
