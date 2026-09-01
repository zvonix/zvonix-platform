/**
 * Шлюзы партнёров и каналы клиентов: человеческая часть (ADR-0009).
 */

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import {
  channelStatusSchema,
  createChannelSchema,
  createGatewaySchema,
  gatewayStatusSchema,
} from './schemas.js';
import type { ChannelRow, GatewayRow } from './telephony.repository.js';
import { TelephonyService, type IssuedSipAccount } from './telephony.service.js';

/**
 * Учётные данные SIP в ответ на выдачу.
 *
 * `password` присутствует **только здесь и только один раз**: в базе лежит `MD5(имя:realm:пароль)`,
 * и восстановить пароль неоткуда. Потерян — перевыпускается, старый перестаёт работать.
 */
interface SipAccountView {
  readonly username: string;
  readonly password: string;
  readonly realm: string;
}

interface GatewayView {
  readonly id: string;
  readonly partner_id: string;
  readonly name: string;
  readonly type: string;
  readonly status: string;
  readonly sip_username: string;
  readonly node_id: string | null;
  readonly registered_at: string | null;
  readonly model: string | null;
  readonly port_count: number;
}

interface ChannelView {
  readonly id: string;
  readonly client_id: string;
  readonly name: string;
  readonly status: string;
  readonly sip_username: string;
  readonly recording_required: boolean;
  readonly caller_id: string | null;
}

@Controller()
export class TelephonyController {
  constructor(private readonly telephony: TelephonyService) {}

  // --- Шлюзы -----------------------------------------------------------------

  @Roles('admin')
  @Post('gateways')
  async createGateway(
    @Body(zodBody(createGatewaySchema)) body: z.infer<typeof createGatewaySchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ gateway: GatewayView; account: SipAccountView }> {
    const created = await this.telephony.createGateway(
      {
        partnerId: parseId(body.partnerId, 'partner'),
        name: body.name,
        type: body.type,
        model: body.model ?? null,
        portCount: body.portCount,
      },
      actor.userId,
      actor.role,
    );
    return { gateway: toGatewayView(created.gateway), account: toAccountView(created.account) };
  }

  @Roles('admin', 'support')
  @Get('gateways')
  async listGateways(@Query('partnerId') partnerId?: string): Promise<{ gateways: GatewayView[] }> {
    const rows = await this.telephony.listGateways(
      partnerId === undefined ? undefined : parseId(partnerId, 'partner'),
    );
    return { gateways: rows.map(toGatewayView) };
  }

  /**
   * Смена состояния шлюза.
   *
   * Отключение действует немедленно: каталог перестаёт отдавать учётную запись,
   * и следующая регистрация не проходит. Уже установленные вызовы не рвутся —
   * их завершает сам разговор.
   */
  @Roles('admin')
  @Post('gateways/:id/status')
  async setGatewayStatus(
    @Param('id') id: string,
    @Body(zodBody(gatewayStatusSchema)) body: z.infer<typeof gatewayStatusSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ gateway: GatewayView }> {
    const updated = await this.telephony.setGatewayStatus(
      parseId(id, 'gateway'),
      body.status,
      actor.userId,
      actor.role,
    );
    return { gateway: toGatewayView(updated) };
  }

  /**
   * Перевыпуск учётных данных: меняются и имя, и пароль.
   *
   * Только пароля мало: имя уже засветилось в записи регистрации и в логах узла,
   * а перенастраивать оборудование партнёру всё равно придётся.
   */
  @Roles('admin')
  @Post('gateways/:id/credentials')
  async resetGatewayCredentials(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ account: SipAccountView }> {
    const account = await this.telephony.resetGatewayCredentials(
      parseId(id, 'gateway'),
      actor.userId,
      actor.role,
    );
    return { account: toAccountView(account) };
  }

  // --- Каналы ----------------------------------------------------------------

  @Roles('admin')
  @Post('channels')
  async createChannel(
    @Body(zodBody(createChannelSchema)) body: z.infer<typeof createChannelSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ channel: ChannelView; account: SipAccountView }> {
    const created = await this.telephony.createChannel(
      {
        clientId: parseId(body.clientId, 'client'),
        name: body.name,
        recordingRequired: body.recordingRequired,
        callerId: body.callerId ?? null,
      },
      actor.userId,
      actor.role,
    );
    return { channel: toChannelView(created.channel), account: toAccountView(created.account) };
  }

  @Roles('admin', 'support')
  @Get('channels')
  async listChannels(@Query('clientId') clientId?: string): Promise<{ channels: ChannelView[] }> {
    const rows = await this.telephony.listChannels(
      clientId === undefined ? undefined : parseId(clientId, 'client'),
    );
    return { channels: rows.map(toChannelView) };
  }

  @Roles('admin')
  @Post('channels/:id/status')
  async setChannelStatus(
    @Param('id') id: string,
    @Body(zodBody(channelStatusSchema)) body: z.infer<typeof channelStatusSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ channel: ChannelView }> {
    const updated = await this.telephony.setChannelStatus(
      parseId(id, 'channel'),
      body.status,
      actor.userId,
      actor.role,
    );
    return { channel: toChannelView(updated) };
  }
}

function toAccountView(account: IssuedSipAccount): SipAccountView {
  return { username: account.username, password: account.password, realm: account.realm };
}

function toGatewayView(row: GatewayRow): GatewayView {
  // Поля перечислены поимённо: расширяющая запись однажды отдала бы наружу `a1_hash`.
  return {
    id: row.id,
    partner_id: row.partnerId,
    name: row.name,
    type: row.type,
    status: row.status,
    sip_username: row.sipUsername,
    node_id: row.nodeId,
    registered_at: row.registeredAt?.toISOString() ?? null,
    model: row.model,
    port_count: row.portCount,
  };
}

function toChannelView(row: ChannelRow): ChannelView {
  return {
    id: row.id,
    client_id: row.clientId,
    name: row.name,
    status: row.status,
    sip_username: row.sipUsername,
    recording_required: row.recordingRequired,
    caller_id: row.callerId,
  };
}
