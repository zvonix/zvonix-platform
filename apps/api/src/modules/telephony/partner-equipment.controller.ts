/**
 * Оборудование так, как его видит **сам партнёр**.
 *
 * Партнёр выводится из сессии: административные обработчики оборудования начинаются
 * с `partnerId` в теле или параметре, и открыть их роли `partner` значило бы разрешить
 * подставить чужой.
 *
 * Здесь же партнёр своё оборудование и **заводит**
 * ([ADR-0043](../../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md)):
 * никто, кроме него, не знает ни модели GOIP, ни номера SIM в третьем порту. Каждый
 * изменяющий обработчик начинается с проверки владения, и чужой объект отвечает `404`,
 * а не `403`: партнёр не должен узнавать даже того, что объект существует.
 *
 * Отдаются **факты, а не приговор**: состояние шлюза, есть ли у него регистрация на узле,
 * что вставлено в порты и в каком состоянии SIM. Вывод «почему через меня не идут вызовы»
 * складывается из этих фактов вместе с состоянием самого партнёра
 * (`GET /partner/account`) и наличием цены по направлению (`GET /partner/rates`).
 * Складывать его здесь значило бы завести второе описание условий отбора рядом
 * с запросом `findSimCandidates` — и разойтись с ним на первой же правке.
 */

import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { parseId, partnerFacingSuspension } from '@zvonix/shared';
import type {
  GatewayPortState,
  GatewayStatus,
  GatewayType,
  PartnerFacingSuspension,
  SimNetworkScope,
  SimStatus,
} from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import type { Principal } from '../identity/identity.service.js';
import {
  addPortSchema,
  assignSimSchema,
  partnerGatewaySchema,
  partnerGatewayStatusSchema,
  partnerSimSchema,
  partnerSimStatusSchema,
} from './schemas.js';
import { TelephonyService } from './telephony.service.js';
import type {
  GatewayPortRow,
  GatewayRow,
  SimCardRow,
  SipTrunkRow,
} from './telephony.repository.js';

/**
 * SIM в ответе партнёру.
 *
 * Номер здесь есть: это его собственная карта, а не номер абонента. Оператор назван
 * именем — идентификатор партнёру не говорит ничего, а сверяет он по названию.
 */
interface SimView {
  readonly id: string;
  readonly msisdn: string;
  readonly status: SimStatus;
  readonly operator_id: string;
  readonly operator_name: string | null;
  readonly network_scope: SimNetworkScope;
  readonly max_concurrent_calls: number;
  /** Подтверждён ли оператор карты. Неподтверждённая карта вызовов не получает. */
  readonly operator_confirmed_at: string | null;
}

interface PortView {
  readonly id: string;
  readonly port_number: number;
  readonly state: GatewayPortState;
  readonly sim: SimView | null;
}

/**
 * Шлюз партнёра вместе с портами.
 *
 * `on_node` — есть ли у шлюза регистрация на узле. Без неё вызов на него не уйдёт
 * вообще: диалплан набирает шлюз как зарегистрированного пользователя, и отбор
 * кандидатов сужается узлом, приславшим запрос. Это единственная строчка, которую
 * может починить только партнёр, — и до сих пор она была видна только нам.
 */
interface GatewayView {
  readonly id: string;
  readonly name: string;
  readonly type: GatewayType;
  readonly status: GatewayStatus;
  /**
   * Кто выключил — как это видит партнёр (ADR-0047). `partner` он снимает сам;
   * `platform` и `failure_threshold` — нет. Кто именно на площадке, не раскрывается.
   */
  readonly suspended_by: PartnerFacingSuspension | null;
  readonly model: string | null;
  readonly on_node: boolean;
  readonly registered_at: string | null;
  readonly ports: readonly PortView[];
}

/**
 * SIP-транк партнёра.
 *
 * Ни пароля провайдера, ни намёка на него: он шифруется и уходит **только узлу**
 * ([ADR-0039](../../../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
 * Имя учётной записи остаётся — по нему партнёр опознаёт транк у провайдера.
 */
interface TrunkView {
  readonly id: string;
  readonly name: string;
  readonly status: GatewayStatus;
  readonly proxy_host: string;
  readonly registers_outbound: boolean;
  readonly outbound_username: string | null;
  readonly max_concurrent_calls: number;
  readonly on_node: boolean;
}

@Controller()
export class PartnerEquipmentController {
  constructor(
    private readonly telephony: TelephonyService,
    private readonly billing: BillingService,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Всё железо партнёра одним ответом.
   *
   * Одним, а не тремя обращениями: шлюз без портов и порт без SIM не значат ничего
   * по отдельности, и собирать эту картину в браузере тремя запросами значило бы
   * показывать её по частям, каждую со своей ошибкой загрузки.
   *
   * Карты без порта отдаются отдельным списком: это заведённая, но не вставленная
   * ёмкость, и она нигде больше не видна — в шлюзах её нет по определению.
   */
  @Roles('partner')
  @Get('partner/equipment')
  async equipment(@CurrentUser() actor: Principal): Promise<{
    gateways: GatewayView[];
    trunks: TrunkView[];
    spare_sims: SimView[];
  }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);

    const [gateways, sims, trunks, ports] = await Promise.all([
      this.telephony.listGateways(partner.id),
      this.telephony.listSims(partner.id),
      this.telephony.listTrunks(partner.id),
      this.telephony.listPartnerPorts(partner.id),
    ]);

    const operators = await this.catalog.operatorNamesOf(sims.map((sim) => sim.operatorId));
    const simById = new Map(sims.map((sim) => [sim.id, sim]));

    const portsByGateway = new Map<string, GatewayPortRow[]>();
    for (const port of ports) {
      const own = portsByGateway.get(port.gatewayId);
      if (own === undefined) portsByGateway.set(port.gatewayId, [port]);
      else own.push(port);
    }

    // Транк — это тоже шлюз, и `listGateways` возвращает его наравне с GOIP. В списке
    // шлюзов ему делать нечего: у него нет ни портов, ни SIM, а есть адрес провайдера.
    //
    // Списанное не показывается вовсе: «списал» значит «убрал», а строка остаётся
    // в базе только потому, что на неё ссылаются вызовы. Что именно было списано,
    // видно в журнале действий, а не на рабочем экране.
    const occupied = new Set<string>();
    const gatewayViews = gateways
      .filter((gateway) => gateway.type !== 'sip_trunk' && gateway.status !== 'retired')
      .map((gateway) =>
        toGatewayView(
          gateway,
          (portsByGateway.get(gateway.id) ?? []).map((port) => {
            const sim = port.simCardId === null ? undefined : simById.get(port.simCardId);
            if (sim !== undefined) occupied.add(sim.id);
            return {
              id: port.id,
              port_number: port.portNumber,
              state: port.state,
              sim: sim === undefined ? null : toSimView(sim, operators),
            };
          }),
        ),
      );

    return {
      gateways: gatewayViews,
      trunks: trunks
        .filter(({ gateway }) => gateway.status !== 'retired')
        .map((row) => toTrunkView(row)),
      spare_sims: sims
        .filter((sim) => !occupied.has(sim.id) && sim.status !== 'retired')
        .map((sim) => toSimView(sim, operators)),
    };
  }

  // --- Партнёр заводит своё оборудование (ADR-0043) ---------------------------

  /**
   * Новый шлюз. Учётные данные SIP возвращаются **здесь и один раз** — там же, где
   * партнёр их и вводит, настраивая GOIP. Пока шлюз заводил администратор, пароль
   * обязан был дойти до партнёра перепиской.
   */
  @Roles('partner')
  @Post('partner/gateways')
  async createGateway(
    @Body(zodBody(partnerGatewaySchema)) body: z.infer<typeof partnerGatewaySchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ gateway: GatewayView; account: SipAccountView }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const created = await this.telephony.createOwnGateway(
      {
        partnerId: partner.id,
        name: body.name,
        type: body.type,
        model: body.model ?? null,
        portCount: body.portCount,
      },
      actor.userId,
      actor.role,
    );
    return {
      gateway: toGatewayView(created.gateway, []),
      account: {
        username: created.account.username,
        password: created.account.password,
        realm: created.account.realm,
      },
    };
  }

  /**
   * Включить, выключить или списать свой шлюз.
   *
   * Списание необратимо и потому недоступно оттуда, где шлюз уже отключён площадкой:
   * иначе её рычаг обходился бы связкой «списал — завёл новый».
   */
  @Roles('partner')
  @Post('partner/gateways/:id/status')
  async setGatewayStatus(
    @Param('id') id: string,
    @Body(zodBody(partnerGatewayStatusSchema)) body: z.infer<typeof partnerGatewayStatusSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ gateway: GatewayView }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const updated = await this.telephony.setOwnGatewayStatus(
      parseId(id, 'gateway'),
      partner.id,
      body.status,
      actor.userId,
      actor.role,
    );
    return { gateway: toGatewayView(updated, []) };
  }

  /**
   * Перевыпуск учётных данных SIP.
   *
   * Меняются и имя, и пароль: имя уже засветилось в записи регистрации и в логах узла,
   * а перенастраивать оборудование партнёру всё равно придётся.
   */
  @Roles('partner')
  @Post('partner/gateways/:id/credentials')
  async resetCredentials(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ account: SipAccountView }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const gatewayId = parseId(id, 'gateway');
    await this.telephony.requireOwnGateway(gatewayId, partner.id);

    const account = await this.telephony.resetGatewayCredentials(
      gatewayId,
      actor.userId,
      actor.role,
    );
    return {
      account: { username: account.username, password: account.password, realm: account.realm },
    };
  }

  /** Порт под SIM. Номер — тот, что подписан на корпусе устройства. */
  @Roles('partner')
  @Post('partner/gateways/:id/ports')
  async addPort(
    @Param('id') id: string,
    @Body(zodBody(addPortSchema)) body: z.infer<typeof addPortSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ port: PortSummary }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const gatewayId = parseId(id, 'gateway');
    await this.telephony.requireOwnGateway(gatewayId, partner.id);

    const port = await this.telephony.addPort(gatewayId, body.portNumber, actor.userId, actor.role);
    return { port: toPortSummary(port) };
  }

  /**
   * Новая SIM.
   *
   * Оператора сверяет источник по её собственному номеру, и расхождение — отказ,
   * а не предупреждение ([ADR-0013](../../../../../docs/adr/0013-opredelenie-operatora.md)).
   * Карта заводится неактивной: включает её отдельное действие.
   */
  @Roles('partner')
  @Post('partner/sim-cards')
  async createSim(
    @Body(zodBody(partnerSimSchema)) body: z.infer<typeof partnerSimSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ sim: SimView }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const sim = await this.telephony.createOwnSim(
      {
        partnerId: partner.id,
        operatorId: parseId(body.operatorId, 'operator'),
        msisdn: body.msisdn,
        iccid: body.iccid ?? null,
        activatedAt: body.activatedAt === undefined ? null : new Date(body.activatedAt),
      },
      actor.userId,
      actor.role,
    );
    const operators = await this.catalog.operatorNamesOf([sim.operatorId]);
    return { sim: toSimView(sim, operators) };
  }

  /**
   * Распорядиться своей картой: включить или списать.
   *
   * Одна дверь на оба действия намеренно: две — это два места, где однажды разойдутся
   * проверки владения. Включение проходит только с подтверждённым оператором,
   * списание — только у карты вне порта.
   */
  @Roles('partner')
  @Post('partner/sim-cards/:id/status')
  async setSimStatus(
    @Param('id') id: string,
    @Body(zodBody(partnerSimStatusSchema)) body: z.infer<typeof partnerSimStatusSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ sim: SimView }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const simCardId = parseId(id, 'simCard');
    const sim =
      body.status === 'active'
        ? await this.telephony.activateOwnSim(simCardId, partner.id, actor.userId, actor.role)
        : await this.telephony.retireOwnSim(simCardId, partner.id, actor.userId, actor.role);

    const operators = await this.catalog.operatorNamesOf([sim.operatorId]);
    return { sim: toSimView(sim, operators) };
  }

  /** Вставить SIM в порт или вынуть её оттуда. И порт, и карта обязаны быть своими. */
  @Roles('partner')
  @Post('partner/gateway-ports/:id/sim')
  async assignSim(
    @Param('id') id: string,
    @Body(zodBody(assignSimSchema)) body: z.infer<typeof assignSimSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ port: PortSummary }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const portId = parseId(id, 'gatewayPort');
    await this.telephony.requireOwnPort(portId, partner.id);

    const simCardId = body.simCardId === null ? null : parseId(body.simCardId, 'simCard');
    // Чужую карту в свой порт не вставить: владение проверяется и ею тоже.
    if (simCardId !== null) await this.telephony.requireOwnSim(simCardId, partner.id);

    const port = await this.telephony.assignSimToPort(portId, simCardId, actor.userId, actor.role);
    return { port: toPortSummary(port) };
  }
}

interface SipAccountView {
  readonly username: string;
  readonly password: string;
  readonly realm: string;
}

/** Порт в ответе на действие: без SIM — её состояние партнёр перечитывает целиком. */
interface PortSummary {
  readonly id: string;
  readonly port_number: number;
  readonly state: GatewayPortState;
}

function toPortSummary(port: GatewayPortRow): PortSummary {
  return { id: port.id, port_number: port.portNumber, state: port.state };
}

function toSimView(sim: SimCardRow, operators: Map<string, string>): SimView {
  return {
    id: sim.id,
    msisdn: sim.msisdn,
    status: sim.status,
    operator_id: sim.operatorId,
    operator_name: operators.get(sim.operatorId) ?? null,
    network_scope: sim.networkScope,
    max_concurrent_calls: sim.maxConcurrentCalls,
    operator_confirmed_at: sim.operatorConfirmedAt?.toISOString() ?? null,
  };
}

function toGatewayView(gateway: GatewayRow, ports: readonly PortView[]): GatewayView {
  return {
    id: gateway.id,
    name: gateway.name,
    type: gateway.type,
    status: gateway.status,
    suspended_by:
      gateway.suspendedBy === null ? null : partnerFacingSuspension(gateway.suspendedBy),
    model: gateway.model,
    on_node: gateway.nodeId !== null,
    registered_at: gateway.registeredAt?.toISOString() ?? null,
    ports,
  };
}

function toTrunkView(row: { gateway: GatewayRow; trunk: SipTrunkRow }): TrunkView {
  return {
    id: row.gateway.id,
    name: row.gateway.name,
    status: row.gateway.status,
    proxy_host: row.trunk.proxyHost,
    registers_outbound: row.trunk.registersOutbound,
    outbound_username: row.trunk.outboundUsername,
    max_concurrent_calls: row.trunk.maxConcurrentCalls,
    on_node: row.gateway.nodeId !== null,
  };
}
