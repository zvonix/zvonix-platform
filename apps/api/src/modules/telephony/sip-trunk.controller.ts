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
 * Заводит администратор или сам партнёр ([ADR-0100](../../../../../docs/adr/0100-sip-provayder-partnyora-i-vklyuchenie-posle-proby.md)):
 * у партнёра — без модерации, но только с внешним адресом, а узел выбирает площадка.
 */

import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { internal, parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets, Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import { TariffService } from '../catalog/tariff.service.js';
import type { Principal } from '../identity/identity.service.js';
import {
  createSipTrunkSchema,
  partnerSipTrunkSchema,
  trunkUnlimitedSchema,
  updateSipTrunkSchema,
} from './schemas.js';
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
  /** Кто выключил: порог отказов срабатывает и на транк (ADR-0047). */
  readonly suspended_by: string | null;
  /** Имя исходящего sofia-gateway на узле. По нему транк ищется в логах FreeSWITCH. */
  readonly sip_username: string;
  readonly proxy_host: string;
  readonly registers_outbound: boolean;
  readonly outbound_username: string | null;
  readonly has_secret: boolean;
  readonly max_concurrent_calls: number;
  /** Номеров у провайдера: на них делится рекомендованная работа (ADR-0105). */
  readonly numbers_count: number;
  /** Безлимит от администратора (ADR-0119): ограничения площадки на номер не действуют. */
  readonly unlimited: boolean;
  /** Партнёр попросил безлимит, решения ещё нет; пусто — не просил или решено. */
  readonly unlimited_requested_at: string | null;
  /** Есть ли цена «через SIP» в тарифе транка: без неё клиенты через него не звонят (ADR-0120, п. 9). */
  readonly has_price: boolean;
  /** Связь узла с провайдером (ADR-0121); пусто — узел ещё не сообщал. */
  readonly link: { state: string; status: string; reported_at: string } | null;
  readonly created_at: string;
}

@Controller()
export class SipTrunkController {
  constructor(
    private readonly telephony: TelephonyService,
    private readonly billing: BillingService,
    private readonly tariffs: TariffService,
  ) {}

  private async views(
    rows: readonly { gateway: GatewayRow; trunk: SipTrunkRow }[],
  ): Promise<SipTrunkView[]> {
    const priced = await this.tariffs.hasPrices(
      rows.map(({ gateway }) => ({
        partnerId: gateway.partnerId,
        tariffId: gateway.tariffId,
        terminationKind: 'sip',
      })),
      new Date(),
    );
    return rows.map((row, index) => toTrunkView(row, priced[index] === true));
  }

  private async view(row: { gateway: GatewayRow; trunk: SipTrunkRow }): Promise<SipTrunkView> {
    const [view] = await this.views([row]);
    if (view === undefined) throw internal('Вид транка не собран');
    return view;
  }

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
        numbersCount: body.numbersCount,
      },
      parseId(actor.userId, 'user'),
      actor.role,
    );
    return { trunk: await this.view(created) };
  }

  @Roles('admin', 'support')
  @Get('sip-trunks')
  async list(@Query('partnerId') partnerId?: string): Promise<{ trunks: SipTrunkView[] }> {
    const rows = await this.telephony.listTrunks(
      partnerId === undefined || partnerId === '' ? undefined : parseId(partnerId, 'partner'),
    );
    return { trunks: await this.views(rows) };
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
      trunkChanges(body),
      parseId(actor.userId, 'user'),
      actor.role,
    );
    return { trunk: await this.view(updated) };
  }

  /**
   * Администратор выдаёт или снимает безлимит
   * ([ADR-0119](../../../../../docs/adr/0119-bezlimit-sip-provaydera-po-resheniyu-admina.md)). Отказ на запрос
   * партнёра — тот же вызов с `false`: запрос решён.
   */
  @Roles('admin')
  @Put('sip-trunks/:id/unlimited')
  async setUnlimited(
    @Param('id') id: string,
    @Body(zodBody(trunkUnlimitedSchema)) body: z.infer<typeof trunkUnlimitedSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ trunk: SipTrunkView }> {
    const updated = await this.telephony.setTrunkUnlimited(
      parseId(id, 'gateway'),
      body.unlimited,
      parseId(actor.userId, 'user'),
      actor.role,
    );
    return { trunk: await this.view(updated) };
  }

  /** Партнёр просит безлимит для своего провайдера (ADR-0119); решает администратор. */
  @Cabinets('partner')
  @Post('partner/sip-trunks/:id/unlimited-request')
  @HttpCode(200)
  async requestUnlimited(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ trunk: SipTrunkView }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const updated = await this.telephony.requestOwnTrunkUnlimited(
      parseId(id, 'gateway'),
      partner.id,
      actor.userId,
      actor.role,
    );
    return { trunk: await this.view(updated) };
  }

  /** Партнёр заводит своего провайдера (ADR-0100). Включает его потом сам — `POST /partner/gateways/:id/status`. */
  @Cabinets('partner')
  @Post('partner/sip-trunks')
  async partnerCreate(
    @Body(zodBody(partnerSipTrunkSchema)) body: z.infer<typeof partnerSipTrunkSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ trunk: SipTrunkView }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const created = await this.telephony.createOwnTrunk(
      partner.id,
      {
        name: body.name,
        proxyHost: body.proxyHost,
        registersOutbound: body.registersOutbound,
        outboundUsername: body.outboundUsername ?? null,
        outboundSecret: body.outboundSecret ?? null,
        maxConcurrentCalls: body.maxConcurrentCalls,
        numbersCount: body.numbersCount,
      },
      actor.userId,
      actor.role,
    );
    return { trunk: await this.view(created) };
  }

  @Cabinets('partner')
  @Patch('partner/sip-trunks/:id')
  async partnerUpdate(
    @Param('id') id: string,
    @Body(zodBody(updateSipTrunkSchema)) body: z.infer<typeof updateSipTrunkSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ trunk: SipTrunkView }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const updated = await this.telephony.updateOwnTrunk(
      parseId(id, 'gateway'),
      partner.id,
      trunkChanges(body),
      actor.userId,
      actor.role,
    );
    return { trunk: await this.view(updated) };
  }
}

/** «Поля нет» — «не трогать»: в службу уходят только переданные. */
function trunkChanges(
  body: z.infer<typeof updateSipTrunkSchema>,
): Parameters<TelephonyService['updateTrunk']>[1] {
  return {
    ...(body.proxyHost === undefined ? {} : { proxyHost: body.proxyHost }),
    ...(body.registersOutbound === undefined ? {} : { registersOutbound: body.registersOutbound }),
    ...(body.outboundUsername === undefined ? {} : { outboundUsername: body.outboundUsername }),
    ...(body.outboundSecret === undefined ? {} : { outboundSecret: body.outboundSecret }),
    ...(body.maxConcurrentCalls === undefined
      ? {}
      : { maxConcurrentCalls: body.maxConcurrentCalls }),
    ...(body.numbersCount === undefined ? {} : { numbersCount: body.numbersCount }),
  };
}

function toTrunkView(
  row: { gateway: GatewayRow; trunk: SipTrunkRow },
  hasPrice: boolean,
): SipTrunkView {
  return {
    id: row.gateway.id,
    partner_id: row.gateway.partnerId,
    node_id: row.gateway.nodeId,
    name: row.gateway.name,
    status: row.gateway.status,
    suspended_by: row.gateway.suspendedBy,
    sip_username: row.gateway.sipUsername,
    proxy_host: row.trunk.proxyHost,
    registers_outbound: row.trunk.registersOutbound,
    outbound_username: row.trunk.outboundUsername,
    has_secret: row.trunk.outboundSecret !== null,
    max_concurrent_calls: row.trunk.maxConcurrentCalls,
    numbers_count: row.trunk.numbersCount,
    unlimited: row.trunk.unlimited,
    unlimited_requested_at: row.trunk.unlimitedRequestedAt?.toISOString() ?? null,
    has_price: hasPrice,
    link:
      row.trunk.linkReportedAt === null ||
      row.trunk.linkState === null ||
      row.trunk.linkStatus === null
        ? null
        : {
            state: row.trunk.linkState,
            status: row.trunk.linkStatus,
            reported_at: row.trunk.linkReportedAt.toISOString(),
          },
    created_at: row.gateway.createdAt.toISOString(),
  };
}
