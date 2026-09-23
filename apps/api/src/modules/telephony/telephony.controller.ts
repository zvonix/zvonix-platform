/**
 * Шлюзы партнёров и каналы клиентов: человеческая часть (ADR-0009).
 */

import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets, Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import {
  addPortSchema,
  allowedOperatorsSchema,
  assignSimSchema,
  channelStatusSchema,
  createChannelSchema,
  createGatewaySchema,
  createSimSchema,
  gatewayStatusSchema,
  partnerCoverageSchema,
  partnerPrioritiesSchema,
  simConcurrencySchema,
  simStatusSchema,
  updateChannelSchema,
} from './schemas.js';
import type {
  AllowedOperatorRow,
  ChannelRow,
  GatewayPortRow,
  GatewayRow,
  SimCardRow,
} from './telephony.repository.js';
import {
  TelephonyService,
  type IssuedSipAccount,
  type PartnerCoverageView,
  type PartnerPriorityView,
} from './telephony.service.js';

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

/**
 * Регион в покрытии партнёра.
 *
 * Ключ отдаётся рядом с названием: по нему видно, во что превратилось написание,
 * и почему `Красноярский кр.` и `Красноярский край` — один регион, а не два.
 */
interface CoverageView {
  readonly region: string;
  readonly region_key: string;
}

interface GatewayView {
  readonly id: string;
  readonly partner_id: string;
  readonly name: string;
  readonly type: string;
  readonly status: string;
  /** Кто выключил: задан ровно у `suspended` (ADR-0047) — от этого зависит, кто вправе вернуть. */
  readonly suspended_by: string | null;
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

/**
 * SIM в ответе.
 *
 * Номер здесь полный: этот обработчик доступен только администратору и поддержке.
 * **В клиентский контур ни номер SIM, ни ICCID не попадают ни в каком виде**
 * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)): по номеру
 * клиент вышел бы на партнёра напрямую в обход платформы.
 */
interface SimView {
  readonly id: string;
  readonly partner_id: string;
  readonly operator_id: string;
  readonly msisdn: string;
  readonly iccid: string | null;
  readonly status: string;
  readonly network_scope: string;
  readonly max_concurrent_calls: number;
  readonly operator_confirmed_at: string | null;
  readonly activated_at: string | null;
}

interface PortView {
  readonly id: string;
  readonly gateway_id: string;
  readonly port_number: number;
  readonly sim_card_id: string | null;
  readonly state: string;
}

/** Кандидат на терминацию: что увидит поддержка, разбирая «почему не звонит». */
interface CandidateView {
  readonly sim_card_id: string;
  readonly msisdn: string;
  readonly max_concurrent_calls: number;
  readonly gateway_id: string;
  readonly gateway_type: string;
  readonly port_number: number;
  readonly port_state: string;
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

  /**
   * Правка настроек канала: название, требование записи, номер для показа.
   *
   * Учётных данных не касается — их меняет только перевыпуск. До появления этого
   * обработчика сменить номер для показа можно было единственным способом: завести
   * канал заново, то есть выдать новый пароль SIP и заставить клиента перенастроить АТС.
   */
  @Roles('admin')
  @Patch('channels/:id')
  async updateChannel(
    @Param('id') id: string,
    @Body(zodBody(updateChannelSchema)) body: z.infer<typeof updateChannelSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ channel: ChannelView }> {
    // Ключи переносятся поштучно, а не разворотом всего тела: при
    // `exactOptionalPropertyTypes` «поля нет» и «поле равно undefined» — разные вещи,
    // и второе затёрло бы значение вместо того, чтобы его не трогать.
    const updated = await this.telephony.updateChannel(
      parseId(id, 'channel'),
      {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.recordingRequired === undefined
          ? {}
          : { recordingRequired: body.recordingRequired }),
        ...(body.callerId === undefined ? {} : { callerId: body.callerId }),
      },
      actor.userId,
      actor.role,
    );
    return { channel: toChannelView(updated) };
  }

  /**
   * Перевыпуск учётных данных канала: меняются и имя, и пароль.
   *
   * Симметрично шлюзу. Утёкший пароль канала — это чужие вызовы за счёт клиента,
   * и без этого обработчика единственным ответом на утечку было бы отключение канала.
   */
  @Roles('admin')
  @Post('channels/:id/credentials')
  async resetChannelCredentials(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ account: SipAccountView }> {
    const account = await this.telephony.resetChannelCredentials(
      parseId(id, 'channel'),
      actor.userId,
      actor.role,
    );
    return { account: toAccountView(account) };
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

  /**
   * Порядок партнёров в канале (ADR-0014).
   *
   * Партнёры названы **псевдонимами**: клиент знает их только так, и приём `partner_id`
   * означал бы, что личность партнёра ему где-то показали. Администратор смотрит тот же
   * список — двух представлений у одного порядка быть не должно.
   */
  @Roles('admin', 'support')
  @Cabinets('client')
  @Get('channels/:id/partner-priorities')
  async listPartnerPriorities(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ priorities: PartnerPriorityResponse[] }> {
    const rows = await this.telephony.listPartnerPriorities(parseId(id, 'channel'), {
      userId: actor.userId,
      role: actor.role,
    });
    return { priorities: rows.map(toPriorityView) };
  }

  /**
   * Задаёт порядок целиком.
   *
   * `PUT`, а не `POST`: список заменяется, а не дополняется. Правка по одному оставляла бы
   * канал с порядком, которого клиент не задавал, — а порядок здесь и есть суть.
   * Пустой список снимает ограничение: канал возвращается к перебору всех партнёров.
   */
  @Roles('admin')
  @Cabinets('client')
  @Put('channels/:id/partner-priorities')
  async setPartnerPriorities(
    @Param('id') id: string,
    @Body(zodBody(partnerPrioritiesSchema)) body: z.infer<typeof partnerPrioritiesSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ priorities: PartnerPriorityResponse[] }> {
    const rows = await this.telephony.setPartnerPriorities(
      parseId(id, 'channel'),
      body.priorities,
      { userId: actor.userId, role: actor.role },
    );
    return { priorities: rows.map(toPriorityView) };
  }

  /**
   * Операторы, на которых каналу разрешено звонить (ADR-0025).
   *
   * Пустой список означает «все операторы»: иначе новый канал не смог бы позвонить,
   * пока кто-то его не заполнит.
   */
  @Roles('admin', 'support')
  @Cabinets('client')
  @Get('channels/:id/allowed-operators')
  async listAllowedOperators(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ operators: string[] }> {
    const rows = await this.telephony.listAllowedOperators(parseId(id, 'channel'), {
      userId: actor.userId,
      role: actor.role,
    });
    return { operators: rows.map(toOperatorId) };
  }

  /** `PUT`, а не `POST`: список заменяется целиком. Пустой снимает ограничение. */
  @Roles('admin')
  @Cabinets('client')
  @Put('channels/:id/allowed-operators')
  async setAllowedOperators(
    @Param('id') id: string,
    @Body(zodBody(allowedOperatorsSchema)) body: z.infer<typeof allowedOperatorsSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ operators: string[] }> {
    const rows = await this.telephony.setAllowedOperators(parseId(id, 'channel'), body.operators, {
      userId: actor.userId,
      role: actor.role,
    });
    return { operators: rows.map(toOperatorId) };
  }

  // --- Покрытие партнёра по регионам ------------------------------------------

  /**
   * В какие регионы партнёр принимает вызовы (ADR-0022).
   *
   * Клиенту не показывается ни в каком виде: покрытие — свойство партнёра, а партнёра
   * клиент знает только под псевдонимом (ADR-0014).
   */
  @Roles('admin', 'support')
  @Get('partners/:id/coverage')
  async listCoverage(@Param('id') id: string): Promise<{ regions: CoverageView[] }> {
    const rows = await this.telephony.listPartnerCoverage(parseId(id, 'partner'));
    return { regions: rows.map(toCoverageView) };
  }

  /**
   * Задаёт список регионов целиком.
   *
   * `PUT`, а не `POST`: список заменяется. Пустой список означает «все регионы» —
   * то есть снятие ограничения, а не запрет всего.
   */
  @Roles('admin')
  @Put('partners/:id/coverage')
  async setCoverage(
    @Param('id') id: string,
    @Body(zodBody(partnerCoverageSchema)) body: z.infer<typeof partnerCoverageSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ regions: CoverageView[] }> {
    const rows = await this.telephony.setPartnerCoverage(
      parseId(id, 'partner'),
      body.regions,
      actor.userId,
      actor.role,
    );
    return { regions: rows.map(toCoverageView) };
  }

  // --- SIM-карты --------------------------------------------------------------

  @Roles('admin')
  @Post('sim-cards')
  async createSim(
    @Body(zodBody(createSimSchema)) body: z.infer<typeof createSimSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ sim: SimView }> {
    const sim = await this.telephony.createSim(
      {
        partnerId: parseId(body.partnerId, 'partner'),
        operatorId: parseId(body.operatorId, 'operator'),
        msisdn: body.msisdn,
        iccid: body.iccid ?? null,
        activatedAt: body.activatedAt === undefined ? null : new Date(body.activatedAt),
      },
      actor.userId,
      actor.role,
    );
    return { sim: toSimView(sim) };
  }

  @Roles('admin', 'support')
  @Get('sim-cards')
  async listSims(@Query('partnerId') partnerId?: string): Promise<{ sim_cards: SimView[] }> {
    const rows = await this.telephony.listSims(
      partnerId === undefined ? undefined : parseId(partnerId, 'partner'),
    );
    return { sim_cards: rows.map(toSimView) };
  }

  @Roles('admin')
  @Post('sim-cards/:id/status')
  async setSimStatus(
    @Param('id') id: string,
    @Body(zodBody(simStatusSchema)) body: z.infer<typeof simStatusSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ sim: SimView }> {
    const updated = await this.telephony.setSimStatus(
      parseId(id, 'simCard'),
      body.status,
      actor.userId,
      actor.role,
    );
    return { sim: toSimView(updated) };
  }

  /**
   * Число одновременных вызовов на SIM — **только администратор**.
   *
   * Инвариант DOMAIN.md. Партнёр заинтересован поднять значение и не увидеть последствий
   * сразу: оператор блокирует SIM за поведение, не похожее на человеческое, и позже.
   */
  @Roles('admin')
  @Post('sim-cards/:id/concurrency')
  async setSimConcurrency(
    @Param('id') id: string,
    @Body(zodBody(simConcurrencySchema)) body: z.infer<typeof simConcurrencySchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ sim: SimView }> {
    const updated = await this.telephony.setSimConcurrency(
      parseId(id, 'simCard'),
      body.maxConcurrentCalls,
      actor.userId,
      actor.role,
    );
    return { sim: toSimView(updated) };
  }

  // --- Порты -------------------------------------------------------------------

  @Roles('admin')
  @Post('gateways/:id/ports')
  async addPort(
    @Param('id') id: string,
    @Body(zodBody(addPortSchema)) body: z.infer<typeof addPortSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ port: PortView }> {
    const port = await this.telephony.addPort(
      parseId(id, 'gateway'),
      body.portNumber,
      actor.userId,
      actor.role,
    );
    return { port: toPortView(port) };
  }

  @Roles('admin', 'support')
  @Get('gateways/:id/ports')
  async listPorts(@Param('id') id: string): Promise<{ ports: PortView[] }> {
    const rows = await this.telephony.listPorts(parseId(id, 'gateway'));
    return { ports: rows.map(toPortView) };
  }

  /** Установка SIM в порт или её извлечение (`simCardId: null`). */
  @Roles('admin')
  @Post('gateway-ports/:id/sim')
  async assignSim(
    @Param('id') id: string,
    @Body(zodBody(assignSimSchema)) body: z.infer<typeof assignSimSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ port: PortView }> {
    const updated = await this.telephony.assignSimToPort(
      parseId(id, 'gatewayPort'),
      body.simCardId === null ? null : parseId(body.simCardId, 'simCard'),
      actor.userId,
      actor.role,
    );
    return { port: toPortView(updated) };
  }

  /**
   * Какие SIM вообще подходят под оператора.
   *
   * Разбор «почему у клиента не звонит» почти всегда сводится к этому вопросу,
   * и отвечать на него по логам неудобно.
   */
  @Roles('admin', 'support')
  @Get('routing/sim-candidates')
  async simCandidates(
    @Query('operatorId') operatorId: string,
    @Query('recording') recording?: string,
    @Query('region') region?: string,
  ): Promise<{ candidates: CandidateView[] }> {
    const found = await this.telephony.findSimCandidates(
      parseId(operatorId, 'operator'),
      recording === 'true',
      // Без региона — все подходящие SIM; с регионом — ровно то, что увидит
      // маршрутизация, вместе с отсевом по покрытию партнёра (ADR-0022).
      region,
    );
    return {
      candidates: found.map((item) => ({
        sim_card_id: item.sim.id,
        msisdn: item.sim.msisdn,
        max_concurrent_calls: item.sim.maxConcurrentCalls,
        gateway_id: item.gateway.id,
        gateway_type: item.gateway.type,
        port_number: item.port.portNumber,
        port_state: item.port.state,
      })),
    };
  }
}

function toOperatorId(row: AllowedOperatorRow): string {
  return row.operatorId;
}

function toCoverageView(row: PartnerCoverageView): CoverageView {
  return { region: row.region, region_key: row.regionKey };
}

function toSimView(row: SimCardRow): SimView {
  return {
    id: row.id,
    partner_id: row.partnerId,
    operator_id: row.operatorId,
    msisdn: row.msisdn,
    iccid: row.iccid,
    status: row.status,
    network_scope: row.networkScope,
    max_concurrent_calls: row.maxConcurrentCalls,
    operator_confirmed_at: row.operatorConfirmedAt?.toISOString() ?? null,
    activated_at: row.activatedAt?.toISOString() ?? null,
  };
}

function toPortView(row: GatewayPortRow): PortView {
  return {
    id: row.id,
    gateway_id: row.gatewayId,
    port_number: row.portNumber,
    sim_card_id: row.simCardId,
    state: row.state,
  };
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
    suspended_by: row.suspendedBy,
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

/** Партнёр в порядке канала. Ни идентификатора партнёра, ни имени — только псевдоним. */
interface PartnerPriorityResponse {
  alias_id: string;
  display_name: string;
  /** Через что уходит вызов: SIM и транк одного партнёра — разные предложения (ADR-0040). */
  termination_kind: string;
  priority: number;
  last_routed_at: string | null;
}

function toPriorityView(row: PartnerPriorityView): PartnerPriorityResponse {
  return {
    alias_id: row.aliasId,
    display_name: row.displayName,
    termination_kind: row.terminationKind,
    priority: row.priority,
    last_routed_at: row.lastRoutedAt?.toISOString() ?? null,
  };
}
