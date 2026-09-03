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
import type { LimitRuleRow } from './limit.repository.js';
import { LimitService, type LimitUsage } from './limit.service.js';
import { addLimitSchema, changeLimitSchema } from './schemas.js';

interface LimitView {
  readonly id: string;
  readonly client_id: string | null;
  readonly channel_id: string | null;
  readonly partner_id: string | null;
  readonly sim_card_id: string | null;
  readonly window: string;
  readonly metric: string;
  readonly value: number;
}

/**
 * Лимит вместе с израсходованным.
 *
 * `used` и `limit` — в единицах хранения: звонки штуками, минуты секундами. Разбор
 * «почему не звонит» начинается отсюда, и пересчитывать секунды в минуты на глаз
 * там не нужно.
 */
interface LimitUsageView extends LimitView {
  readonly bucket_start: string;
  readonly used: number;
  readonly limit: number;
  readonly exceeded: boolean;
}

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
    const row = await this.limits.changeValue(
      parseId(id, 'limitRule'),
      body.value,
      actor.userId,
      actor.role,
    );
    return { limit: toLimitView(row) };
  }

  /** Удаление уносит и счётчики: это и есть способ обнулить израсходованное. */
  @Roles('admin')
  @Delete('limits/:id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ limit: LimitView }> {
    const row = await this.limits.remove(parseId(id, 'limitRule'), actor.userId, actor.role);
    return { limit: toLimitView(row) };
  }
}

function toLimitView(row: LimitRuleRow): LimitView {
  return {
    id: row.id,
    client_id: row.clientId,
    channel_id: row.channelId,
    partner_id: row.partnerId,
    sim_card_id: row.simCardId,
    window: row.window,
    metric: row.metric,
    value: row.value,
  };
}

function toUsageView(usage: LimitUsage): LimitUsageView {
  return {
    ...toLimitView(usage.rule),
    bucket_start: usage.bucketStart.toISOString(),
    used: usage.used,
    limit: usage.limit,
    exceeded: usage.exceeded,
  };
}
