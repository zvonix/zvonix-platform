/**
 * SIP-транки партнёров ([ADR-0039](../../../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
 *
 * Транк — это шлюз вида `sip_trunk`: у него тот же владелец, то же состояние и те же
 * пороги качества, что у GOIP. Отличается он тем, что **регистрация идёт в обратную
 * сторону** — не он к нам, а мы к нему, — и потому у него нет ни SIM, ни портов,
 * а ёмкость меряется числом одновременных вызовов.
 *
 * Состояние меняется общим обработчиком `POST /gateways/:id/status`: транк это шлюз,
 * и второй способ включать и выключать его разошёлся бы с первым.
 *
 * Заводит **администратор**: пароль провайдера — чужой секрет, за утечку которого
 * платит партнёр, а своего кабинета у партнёра ещё нет.
 */

import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { createSipTrunkSchema, updateSipTrunkSchema } from './schemas.js';
import { TelephonyService } from './telephony.service.js';
import type { GatewayRow, SipTrunkRow } from './telephony.repository.js';

/**
 * Транк в ответе человеку.
 *
 * **Пароля провайдера здесь нет никогда** — только признак, задан ли он. Восстановить
 * пароль из ответа API невозможно: он уходит одному лишь узлу, и то в его конфигурацию.
 */
interface SipTrunkView {
  readonly id: string;
  readonly partner_id: string;
  readonly node_id: string | null;
  readonly name: string;
  readonly status: string;
  /** Имя исходящего sofia-gateway на узле. По нему транк ищется в логах FreeSWITCH. */
  readonly sip_username: string;
  readonly proxy_host: string;
  readonly registers_outbound: boolean;
  readonly outbound_username: string | null;
  readonly has_secret: boolean;
  readonly max_concurrent_calls: number;
  readonly created_at: string;
}

@Controller()
export class SipTrunkController {
  constructor(private readonly telephony: TelephonyService) {}

  @Roles('admin')
  @Post('sip-trunks')
  async create(
    @Body(zodBody(createSipTrunkSchema)) body: z.infer<typeof createSipTrunkSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ trunk: SipTrunkView }> {
    const created = await this.telephony.createTrunk(
      {
        partnerId: parseId(body.partnerId, 'partner'),
        nodeId: parseId(body.nodeId, 'node'),
        name: body.name,
        proxyHost: body.proxyHost,
        registersOutbound: body.registersOutbound,
        outboundUsername: body.outboundUsername ?? null,
        outboundSecret: body.outboundSecret ?? null,
        maxConcurrentCalls: body.maxConcurrentCalls,
      },
      parseId(actor.userId, 'user'),
      actor.role,
    );
    return { trunk: toTrunkView(created) };
  }

  @Roles('admin', 'support')
  @Get('sip-trunks')
  async list(@Query('partnerId') partnerId?: string): Promise<{ trunks: SipTrunkView[] }> {
    const rows = await this.telephony.listTrunks(
      partnerId === undefined || partnerId === '' ? undefined : parseId(partnerId, 'partner'),
    );
    return { trunks: rows.map(toTrunkView) };
  }

  /**
   * Правка транка.
   *
   * «Поля нет» означает «не трогать», а не «очистить»: правка одного лишь адреса
   * не должна стирать учётные данные — транк перестал бы подниматься, и узнать об этом
   * было бы неоткуда, кроме лога узла.
   */
  @Roles('admin')
  @Patch('sip-trunks/:id')
  async update(
    @Param('id') id: string,
    @Body(zodBody(updateSipTrunkSchema)) body: z.infer<typeof updateSipTrunkSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ trunk: SipTrunkView }> {
    const updated = await this.telephony.updateTrunk(
      parseId(id, 'gateway'),
      {
        ...(body.proxyHost === undefined ? {} : { proxyHost: body.proxyHost }),
        ...(body.registersOutbound === undefined
          ? {}
          : { registersOutbound: body.registersOutbound }),
        ...(body.outboundUsername === undefined ? {} : { outboundUsername: body.outboundUsername }),
        ...(body.outboundSecret === undefined ? {} : { outboundSecret: body.outboundSecret }),
        ...(body.maxConcurrentCalls === undefined
          ? {}
          : { maxConcurrentCalls: body.maxConcurrentCalls }),
      },
      parseId(actor.userId, 'user'),
      actor.role,
    );
    return { trunk: toTrunkView(updated) };
  }
}

function toTrunkView(row: { gateway: GatewayRow; trunk: SipTrunkRow }): SipTrunkView {
  return {
    id: row.gateway.id,
    partner_id: row.gateway.partnerId,
    node_id: row.gateway.nodeId,
    name: row.gateway.name,
    status: row.gateway.status,
    sip_username: row.gateway.sipUsername,
    proxy_host: row.trunk.proxyHost,
    registers_outbound: row.trunk.registersOutbound,
    outbound_username: row.trunk.outboundUsername,
    has_secret: row.trunk.outboundSecret !== null,
    max_concurrent_calls: row.trunk.maxConcurrentCalls,
    created_at: row.gateway.createdAt.toISOString(),
  };
}
