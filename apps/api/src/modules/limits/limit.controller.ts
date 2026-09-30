/**
 * Лимиты клиента, канала, партнёра и SIM: человеческая часть (ADR-0026).
 */

import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { LimitService } from './limit.service.js';
import { addLimitSchema, changeLimitSchema } from './schemas.js';
import { toLimitView, toUsageView, type LimitUsageView, type LimitView } from './views.js';

@Controller()
export class LimitController {
  constructor(private readonly limits: LimitService) {}

  @Roles('admin')
  @Post('limits')
  async add(
    @Body(zodBody(addLimitSchema)) body: z.infer<typeof addLimitSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ limit: LimitView }> {
    const row = await this.limits.add(
      {
        clientId: body.clientId === undefined ? null : parseId(body.clientId, 'client'),
        channelId: body.channelId === undefined ? null : parseId(body.channelId, 'channel'),
        partnerId: body.partnerId === undefined ? null : parseId(body.partnerId, 'partner'),
        simCardId: body.simCardId === undefined ? null : parseId(body.simCardId, 'simCard'),
        window: body.window,
        metric: body.metric,
        value: body.value,
        perSim: body.perSim,
        rounding: body.rounding,
        periodStartDay: body.periodStartDay ?? null,
        setBy: 'platform',
      },
      actor.userId,
      actor.role,
    );
    return { limit: toLimitView(row) };
  }

  /**
   * Лимиты субъекта вместе с израсходованным за текущее окно.
   *
   * Без субъекта — все: у администратора это единственный способ увидеть, что вообще
   * заведено, а лимитов на платформе десятки, а не тысячи.
   */
  @Roles('admin', 'support')
  @Get('limits')
  async list(
    @Query('clientId') clientId?: string,
    @Query('channelId') channelId?: string,
    @Query('partnerId') partnerId?: string,
    @Query('simCardId') simCardId?: string,
  ): Promise<{ limits: LimitUsageView[] }> {
    const rows = await this.limits.list(
      {
        ...(clientId === undefined ? {} : { clientId: parseId(clientId, 'client') }),
        ...(channelId === undefined ? {} : { channelId: parseId(channelId, 'channel') }),
        ...(partnerId === undefined ? {} : { partnerIds: [parseId(partnerId, 'partner')] }),
        ...(simCardId === undefined ? {} : { simCardIds: [parseId(simCardId, 'simCard')] }),
      },
      new Date(),
    );
    return { limits: rows.map(toUsageView) };
  }

  @Roles('admin')
  @Put('limits/:id')
  async change(
    @Param('id') id: string,
    @Body(zodBody(changeLimitSchema)) body: z.infer<typeof changeLimitSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ limit: LimitView }> {
    const row = await this.limits.changeRule(parseId(id, 'limitRule'), body, actor);
    return { limit: toLimitView(row) };
  }

  /** Удаление уносит и счётчики: это и есть способ обнулить израсходованное. */
  @Roles('admin')
  @Delete('limits/:id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ limit: LimitView }> {
    const row = await this.limits.remove(parseId(id, 'limitRule'), actor);
    return { limit: toLimitView(row) };
  }
}
