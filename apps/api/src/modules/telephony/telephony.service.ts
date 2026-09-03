/**
 * Учётные записи SIP обеих сторон вызова (ADR-0009).
 *
 * Каталог отдаётся из control plane, а не лежит файлом на узле. Смысл ровно один:
 * заблокировали партнёра — его шлюз перестал регистрироваться при следующей же попытке,
 * без раскатки конфигурации и без перезапуска узла.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  internal as internalError,
  normalizeRegion,
  notFound,
  parseId,
  validationFailed,
  type ChannelStatus,
  type GatewayStatus,
  type GatewayType,
  type Id,
  type Msisdn,
  type SimStatus,
  type UserRole,
} from '@zvonix/shared';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingRepository } from '../billing/billing.repository.js';
import { CatalogRepository } from '../catalog/catalog.repository.js';
import { OperatorResolverService } from '../catalog/operator-resolver.service.js';
import { directoryDocument, notFoundDocument, type DirectoryUser } from './directory-xml.js';
import { issueSipCredentials, type SipCredentials } from './sip-credentials.js';
import {
  TelephonyRepository,
  type AllowedOperatorRow,
  type ChannelId,
  type ChannelRow,
  type GatewayId,
  type GatewayPortId,
  type GatewayPortRow,
  type GatewayRow,
  type SimCandidate,
  type SimCardId,
  type SimCardRow,
} from './telephony.repository.js';

/**
 * Маскирование номера для журнала.
 *
 * Номер SIM — персональные данные партнёра. В журнале нужен опознаваемый след,
 * а не сам номер: `7913*****33`.
 */
function maskMsisdn(msisdn: string): string {
  return `${msisdn.slice(0, 4)}*****${msisdn.slice(-2)}`;
}

/**
 * Партнёр в порядке канала — так, как его видит клиент.
 *
 * Ни `partner_id`, ни имени: клиент знает партнёра только под псевдонимом, и возврат
 * чего-то ещё в клиентский контур ADR-0014 считает дефектом уровня инварианта.
 */
export interface PartnerPriorityView {
  readonly aliasId: Id<'partnerAlias'>;
  readonly displayName: string;
  readonly priority: number;
  readonly lastRoutedAt: Date | null;
}

/**
 * Регион в покрытии партнёра.
 *
 * Ключ отдаётся вместе с названием намеренно: по нему видно, во что превратилось
 * написание, и почему `Красноярский кр.` и `Красноярский край` — один и тот же регион.
 * Разбор «партнёр объявил, а вызовов нет» начинается именно отсюда.
 */
export interface PartnerCoverageView {
  readonly region: string;
  readonly regionKey: string;
}

/** Учётная запись вместе с паролем. Пароль существует только здесь и только один раз. */
export interface IssuedSipAccount {
  readonly username: string;
  readonly password: string;
  readonly realm: string;
}

@Injectable()
export class TelephonyService {
  constructor(
    private readonly repository: TelephonyRepository,
    private readonly billing: BillingRepository,
    private readonly audit: AuditService,
    private readonly resolver: OperatorResolverService,
    private readonly catalog: CatalogRepository,
    @Inject(APP_CONFIG) private readonly config: Config,
  ) {}

  get realm(): string {
    return this.config.SIP_REALM;
  }

  // --- Шлюзы -----------------------------------------------------------------

  async createGateway(
    input: {
      partnerId: Id<'partner'>;
      name: string;
      type: GatewayType;
      model: string | null;
      portCount: number;
    },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<{ gateway: GatewayRow; account: IssuedSipAccount }> {
    const credentials = issueSipCredentials('gateway', this.realm);
    const gateway = await this.repository.createGateway({
      partnerId: input.partnerId,
      name: input.name,
      type: input.type,
      // Шлюз заводится неподтверждённым: учётная запись выдана, но каталог её не отдаёт,
      // пока модерация не пройдена.
      status: 'pending',
      sipUsername: credentials.username,
      a1Hash: credentials.a1Hash,
      model: input.model,
      portCount: input.portCount,
    });

    await this.audit.record({
      action: 'gateway.created',
      entityType: 'gateway',
      entityId: gateway.id,
      actorUserId,
      actorRole,
      // Ни пароля, ни хеша: журнал читают люди, которым они не нужны.
      after: { name: gateway.name, type: gateway.type, sip_username: gateway.sipUsername },
    });

    return { gateway, account: this.toAccount(credentials) };
  }

  /**
   * Перевыпуск учётных данных шлюза.
   *
   * Меняется и имя, и пароль. Только пароль недостаточно: имя уже засветилось в записи
   * регистрации на узле и в логах, а перенастраивать оборудование партнёру всё равно
   * придётся — так пусть меняется всё разом.
   */
  async resetGatewayCredentials(
    id: GatewayId,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<IssuedSipAccount> {
    const existing = await this.repository.findGateway(id);
    if (existing === undefined) throw notFound('Шлюз не найден');

    const credentials = issueSipCredentials('gateway', this.realm);
    const updated = await this.repository.replaceGatewayCredentials(
      id,
      credentials.username,
      credentials.a1Hash,
    );
    if (updated === undefined) throw notFound('Шлюз не найден');

    await this.audit.record({
      action: 'gateway.credentials_reset',
      entityType: 'gateway',
      entityId: id,
      actorUserId,
      actorRole,
      before: { sip_username: existing.sipUsername },
      after: { sip_username: updated.sipUsername },
    });

    return this.toAccount(credentials);
  }

  async setGatewayStatus(
    id: GatewayId,
    status: GatewayStatus,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<GatewayRow> {
    const existing = await this.repository.findGateway(id);
    if (existing === undefined) throw notFound('Шлюз не найден');

    const updated = await this.repository.setGatewayStatus(id, status);
    if (updated === undefined) throw notFound('Шлюз не найден');

    await this.audit.record({
      action: 'gateway.status_changed',
      entityType: 'gateway',
      entityId: id,
      actorUserId,
      actorRole,
      before: { status: existing.status },
      after: { status },
    });

    return updated;
  }

  async listGateways(partnerId?: Id<'partner'>): Promise<GatewayRow[]> {
    return this.repository.listGateways(partnerId);
  }

  // --- Каналы ----------------------------------------------------------------

  async createChannel(
    input: {
      clientId: Id<'client'>;
      name: string;
      recordingRequired: boolean;
      callerId: string | null;
    },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<{ channel: ChannelRow; account: IssuedSipAccount }> {
    const credentials = issueSipCredentials('channel', this.realm);
    const channel = await this.repository.createChannel({
      clientId: input.clientId,
      name: input.name,
      status: 'pending',
      sipUsername: credentials.username,
      a1Hash: credentials.a1Hash,
      recordingRequired: input.recordingRequired,
      callerId: input.callerId,
    });

    await this.audit.record({
      action: 'channel.created',
      entityType: 'channel',
      entityId: channel.id,
      actorUserId,
      actorRole,
      after: {
        name: channel.name,
        sip_username: channel.sipUsername,
        recording_required: channel.recordingRequired,
      },
    });

    return { channel, account: this.toAccount(credentials) };
  }

  async setChannelStatus(
    id: ChannelId,
    status: ChannelStatus,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<ChannelRow> {
    const existing = await this.repository.findChannel(id);
    if (existing === undefined) throw notFound('Канал не найден');

    const updated = await this.repository.setChannelStatus(id, status);
    if (updated === undefined) throw notFound('Канал не найден');

    await this.audit.record({
      action: 'channel.status_changed',
      entityType: 'channel',
      entityId: id,
      actorUserId,
      actorRole,
      before: { status: existing.status },
      after: { status },
    });

    return updated;
  }

  async listChannels(clientId?: Id<'client'>): Promise<ChannelRow[]> {
    return this.repository.listChannels(clientId);
  }

  // --- SIM-карты --------------------------------------------------------------

  /**
   * Заводит SIM и **сверяет объявленного оператора с фактическим**.
   *
   * Партнёр объявляет оператора сам, а от этого значения зависит вся экономика вызова:
   * SIM звонит бесплатно только внутри своей сети ([ADR-0013](../../../../../docs/adr/0013-opredelenie-operatora.md)).
   * Ошибка здесь означает не «чуть дороже», а платный звонок с каждого вызова через эту SIM.
   *
   * Поэтому собственный номер SIM прогоняется через тот же `OperatorResolver`, что и номера
   * назначения. Три исхода, и они разные:
   *
   * - подтверждён и совпал → запись с отметкой о сверке;
   * - **подтверждён и не совпал → отказ.** Это не предупреждение: заводить SIM с заведомо
   *   неверным оператором значит согласиться терять деньги партнёра на каждом вызове;
   * - не подтверждён → запись без отметки. «Источник не знает» и «источник возразил» —
   *   разные утверждения, и второе не следует из первого.
   */
  async createSim(
    input: {
      partnerId: Id<'partner'>;
      operatorId: Id<'operator'>;
      msisdn: Msisdn;
      iccid: string | null;
      activatedAt: Date | null;
    },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<SimCardRow> {
    const resolution = await this.resolver.resolve(input.msisdn);
    let confirmedAt: Date | null = null;

    if (resolution.confirmed && resolution.serving !== undefined) {
      if (resolution.serving.id !== input.operatorId) {
        throw validationFailed('Объявленный оператор не совпадает с фактическим', {
          details: {
            declared_operator_id: input.operatorId,
            actual_operator_id: resolution.serving.id,
            actual_operator: resolution.serving.name,
          },
        });
      }
      confirmedAt = new Date();
    }

    const sim = await this.repository.createSim({
      partnerId: input.partnerId,
      operatorId: input.operatorId,
      msisdn: input.msisdn,
      iccid: input.iccid,
      activatedAt: input.activatedAt,
      operatorConfirmedAt: confirmedAt,
    });

    await this.audit.record({
      action: 'sim.created',
      entityType: 'sim_card',
      entityId: sim.id,
      actorUserId,
      actorRole,
      // Номер маскируется: он персональные данные партнёра, а журнал читают люди,
      // которым полный номер не нужен (ADR-0004).
      after: {
        msisdn: maskMsisdn(sim.msisdn),
        operator_id: sim.operatorId,
        operator_confirmed: confirmedAt !== null,
      },
    });

    return sim;
  }

  async setSimStatus(
    id: SimCardId,
    status: SimStatus,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<SimCardRow> {
    const existing = await this.repository.findSim(id);
    if (existing === undefined) throw notFound('SIM не найдена');

    const updated = await this.repository.setSimStatus(id, status);
    if (updated === undefined) throw notFound('SIM не найдена');

    await this.audit.record({
      action: 'sim.status_changed',
      entityType: 'sim_card',
      entityId: id,
      actorUserId,
      actorRole,
      before: { status: existing.status },
      after: { status },
    });

    return updated;
  }

  /**
   * Меняет число одновременных вызовов на SIM.
   *
   * Инвариант DOMAIN.md: это делает **только администратор**. Партнёр заинтересован
   * поднять значение и не увидеть последствий сразу — а последствие одно и позднее:
   * оператор блокирует SIM за поведение, не похожее на человеческое.
   */
  async setSimConcurrency(
    id: SimCardId,
    value: number,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<SimCardRow> {
    const existing = await this.repository.findSim(id);
    if (existing === undefined) throw notFound('SIM не найдена');

    const updated = await this.repository.setSimConcurrency(id, value);
    if (updated === undefined) throw notFound('SIM не найдена');

    await this.audit.record({
      action: 'sim.concurrency_changed',
      entityType: 'sim_card',
      entityId: id,
      actorUserId,
      actorRole,
      before: { max_concurrent_calls: existing.maxConcurrentCalls },
      after: { max_concurrent_calls: value },
    });

    return updated;
  }

  async listSims(partnerId?: Id<'partner'>): Promise<SimCardRow[]> {
    return this.repository.listSims(partnerId);
  }

  // --- Порты -------------------------------------------------------------------

  async addPort(
    gatewayId: GatewayId,
    portNumber: number,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<GatewayPortRow> {
    const gateway = await this.repository.findGateway(gatewayId);
    if (gateway === undefined) throw notFound('Шлюз не найден');

    const port = await this.repository.createPort({ gatewayId, portNumber });
    await this.audit.record({
      action: 'gateway_port.created',
      entityType: 'gateway_port',
      entityId: port.id,
      actorUserId,
      actorRole,
      after: { gateway_id: gatewayId, port_number: portNumber },
    });
    return port;
  }

  /**
   * Ставит SIM в порт или вынимает её.
   *
   * SIM и порт обязаны принадлежать одному партнёру: иначе чужая SIM оказалась бы
   * в чужом шлюзе, а выручка от вызова ушла бы не тому.
   */
  async assignSimToPort(
    portId: GatewayPortId,
    simCardId: SimCardId | null,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<GatewayPortRow> {
    const port = await this.repository.findPort(portId);
    if (port === undefined) throw notFound('Порт не найден');

    const gateway = await this.repository.findGateway(port.gatewayId);
    if (gateway === undefined) throw notFound('Шлюз не найден');

    if (simCardId !== null) {
      const sim = await this.repository.findSim(simCardId);
      if (sim === undefined) throw notFound('SIM не найдена');
      if (sim.partnerId !== gateway.partnerId) {
        throw validationFailed('SIM и шлюз принадлежат разным партнёрам');
      }
    }

    const updated = await this.repository.setPortSim(portId, simCardId);
    if (updated === undefined) throw notFound('Порт не найден');

    await this.audit.record({
      action: simCardId === null ? 'gateway_port.sim_removed' : 'gateway_port.sim_installed',
      entityType: 'gateway_port',
      entityId: portId,
      actorUserId,
      actorRole,
      before: { sim_card_id: port.simCardId },
      after: { sim_card_id: simCardId },
    });

    return updated;
  }

  async listPorts(gatewayId: GatewayId): Promise<GatewayPortRow[]> {
    return this.repository.listPorts(gatewayId);
  }

  /**
   * Кандидаты на терминацию под конкретного оператора.
   *
   * Понадобится маршрутизации; здесь же доступно поддержке для разбора «почему
   * не звонит» — вопрос почти всегда сводится к «а есть ли вообще подходящая SIM».
   */
  async findSimCandidates(
    operatorId: Id<'operator'>,
    requiresRecording: boolean,
    region?: string,
  ): Promise<SimCandidate[]> {
    return this.repository.findSimCandidates(operatorId, {
      excludeRecordingIncapable: requiresRecording,
      // Без региона покрытие не проверяется: вопрос «какие SIM вообще подходят»
      // задаётся и тогда, когда номера ещё нет. С регионом — то же, что увидит
      // маршрутизация (ADR-0022).
      ...(region === undefined ? {} : { region }),
    });
  }

  // --- Каталог для узла -------------------------------------------------------

  /**
   * Отвечает на запрос каталога от узла.
   *
   * Возвращает готовый XML, а не объект: форма ответа задана FreeSWITCH, и промежуточное
   * представление здесь ничего не даёт, кроме лишнего слоя.
   *
   * Неизвестная и отключённая записи дают **одинаковый** ответ: иначе по разнице
   * заблокированный партнёр узнавал бы, что его шлюз ещё числится в системе.
   */
  async directory(username: string, nodeId: Id<'node'>): Promise<string> {
    const gateway = await this.repository.findRegistrableGateway(username);
    if (gateway !== undefined) {
      // Отметка о том, где шлюз сейчас: по ней видно, живой ли он и на каком узле.
      await this.repository.recordRegistration(gateway.id, nodeId, new Date());
      return directoryDocument(this.realm, {
        username: gateway.sipUsername,
        a1Hash: gateway.a1Hash,
        variables: {
          zvonix_gateway: gateway.id,
          zvonix_gateway_type: gateway.type,
        },
      });
    }

    const channel = await this.repository.findActiveChannel(username);
    if (channel !== undefined) {
      return directoryDocument(this.realm, {
        username: channel.sipUsername,
        a1Hash: channel.a1Hash,
        variables: channelVariables(channel),
      });
    }

    return notFoundDocument();
  }

  /** Ответ «записи нет» — он же ответ на всё, чего мы не обслуживаем. */
  directoryNotFound(): string {
    return notFoundDocument();
  }

  /**
   * Порядок партнёров в канале.
   *
   * Отдаётся псевдонимами: клиент знает партнёра только так, а администратор смотрит
   * тот же список — двух представлений у одного порядка быть не должно.
   */
  async listPartnerPriorities(
    channelId: ChannelId,
    requester: { userId: Id<'user'>; role: UserRole },
  ): Promise<PartnerPriorityView[]> {
    await this.assertChannelAccess(channelId, requester);

    const rows = await this.repository.listPartnerPriorities(channelId);
    const aliases = await this.billing.listAliasesByPartners(rows.map((row) => row.partnerId));
    const byPartner = new Map(aliases.map((alias) => [alias.partnerId, alias]));

    return rows.map((row) => {
      const alias = byPartner.get(row.partnerId);
      if (alias === undefined) {
        // Партнёр без псевдонима клиенту непредставим, а показать вместо него
        // идентификатор — прямое нарушение ADR-0014. Такого быть не должно:
        // псевдоним заводится вместе с партнёром.
        throw internalError('У партнёра из списка канала нет псевдонима');
      }
      return {
        aliasId: alias.id,
        displayName: alias.displayName,
        priority: row.priority,
        lastRoutedAt: row.lastRoutedAt,
      };
    });
  }

  /**
   * Задаёт порядок партнёров в канале целиком.
   *
   * Замена, а не правка по одному: список — это порядок, и менять его частями значит
   * на время оставлять канал с порядком, которого клиент не задавал.
   */
  async setPartnerPriorities(
    channelId: ChannelId,
    entries: readonly { aliasId: string; priority: number }[],
    requester: { userId: Id<'user'>; role: UserRole },
  ): Promise<PartnerPriorityView[]> {
    await this.assertChannelAccess(channelId, requester);

    const seen = new Set<string>();
    const resolved: { partnerId: Id<'partner'>; priority: number }[] = [];

    for (const entry of entries) {
      if (seen.has(entry.aliasId)) {
        throw validationFailed('Один и тот же партнёр указан дважды');
      }
      seen.add(entry.aliasId);

      const alias = await this.billing.findAliasById(parseId(entry.aliasId, 'partnerAlias'));
      // `not_found`, а не `validation_failed`: несуществующий псевдоним и чужой
      // выглядят для вызывающего одинаково, и по разнице ответов их перебирать нельзя.
      if (alias === undefined) throw notFound('Партнёр не найден');

      resolved.push({ partnerId: alias.partnerId, priority: entry.priority });
    }

    const before = await this.repository.listPartnerPriorities(channelId);
    await this.repository.replacePartnerPriorities(channelId, resolved);

    await this.audit.record({
      action: 'channel.partner_priorities_set',
      entityType: 'channel',
      entityId: channelId,
      actorUserId: requester.userId,
      actorRole: requester.role,
      before: { count: before.length },
      after: { count: resolved.length },
    });

    return this.listPartnerPriorities(channelId, requester);
  }

  // --- Разрешённые операторы канала (ADR-0025) ----------------------------------

  /** Пустой список означает «все операторы», а не «ни одного». */
  async listAllowedOperators(
    channelId: ChannelId,
    requester: { userId: Id<'user'>; role: UserRole },
  ): Promise<AllowedOperatorRow[]> {
    await this.assertChannelAccess(channelId, requester);
    return this.repository.listAllowedOperators(channelId);
  }

  /**
   * Задаёт список операторов канала целиком.
   *
   * Замена, а не дополнение: пустой список означает «все операторы», и «дописать одного»
   * к пустому списку означало бы не расширение, а ограничение до единственного оператора.
   */
  async setAllowedOperators(
    channelId: ChannelId,
    operatorIds: readonly string[],
    requester: { userId: Id<'user'>; role: UserRole },
  ): Promise<AllowedOperatorRow[]> {
    await this.assertChannelAccess(channelId, requester);

    const seen = new Set<string>();
    const resolved: Id<'operator'>[] = [];

    for (const raw of operatorIds) {
      const operatorId = parseId(raw, 'operator');
      if (seen.has(operatorId)) {
        throw validationFailed('Один и тот же оператор указан дважды');
      }
      seen.add(operatorId);

      // Несуществующий оператор в списке означал бы, что клиент считает направление
      // разрешённым, а оно недостижимо: список закрытый, и лишней строки в нём не видно.
      const operator = await this.catalog.findOperator(operatorId);
      if (operator === undefined) throw notFound('Оператор не найден');

      resolved.push(operatorId);
    }

    const before = await this.repository.listAllowedOperators(channelId);
    const after = await this.repository.replaceAllowedOperators(channelId, resolved);

    await this.audit.record({
      action: 'channel.allowed_operators_set',
      entityType: 'channel',
      entityId: channelId,
      actorUserId: requester.userId,
      actorRole: requester.role,
      before: { operators: before.map((row) => row.operatorId) },
      after: { operators: after.map((row) => row.operatorId) },
    });

    return after;
  }

  // --- Покрытие партнёра по регионам (ADR-0022) ---------------------------------

  /** Регионы, в которые партнёр готов принимать вызовы. Пустой список означает «все». */
  async listPartnerCoverage(partnerId: Id<'partner'>): Promise<PartnerCoverageView[]> {
    const partner = await this.billing.findPartner(partnerId);
    if (partner === undefined) throw notFound('Партнёр не найден');

    const rows = await this.repository.listCoverage(partnerId);
    return rows.map((row) => ({ region: row.region, regionKey: row.regionKey }));
  }

  /**
   * Задаёт список регионов партнёра целиком.
   *
   * Замена, а не дополнение: пустой список означает «все регионы», и «дописать один
   * регион» к пустому списку означало бы не расширение, а внезапное ограничение
   * до единственного региона.
   */
  async setPartnerCoverage(
    partnerId: Id<'partner'>,
    regions: readonly string[],
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<PartnerCoverageView[]> {
    const partner = await this.billing.findPartner(partnerId);
    if (partner === undefined) throw notFound('Партнёр не найден');

    const seen = new Set<string>();
    const entries: { region: string; regionKey: string }[] = [];

    for (const region of regions) {
      const regionKey = normalizeRegion(region);
      // «Область» или «край» сами по себе региона не называют, а пустой ключ совпал бы
      // с другим пустым и связал два разных региона.
      if (regionKey === '') {
        throw validationFailed(`Не похоже на название региона: «${region}»`);
      }
      // Дубликат — не мелочь: «Красноярский край» и «Красноярский кр.» дают один ключ,
      // и молча схлопнуть их значит вернуть партнёру не тот список, который он задал.
      if (seen.has(regionKey)) {
        throw validationFailed(`Регион указан дважды: «${region}»`);
      }
      seen.add(regionKey);
      entries.push({ region: region.trim(), regionKey });
    }

    const before = await this.repository.listCoverage(partnerId);
    const after = await this.repository.replaceCoverage(partnerId, entries);

    await this.audit.record({
      action: 'partner.coverage_set',
      entityType: 'partner',
      entityId: partnerId,
      actorUserId,
      actorRole,
      before: { regions: before.map((row) => row.region) },
      after: { regions: after.map((row) => row.region) },
    });

    return after.map((row) => ({ region: row.region, regionKey: row.regionKey }));
  }

  /**
   * Право распоряжаться каналом.
   *
   * Роль — первый рубеж, владение проверяется здесь (ADR-0018). Клиент видит и меняет
   * порядок только в своих каналах; чужой канал отвечает `not_found`, а не `403`,
   * иначе по разнице ответов проверяется его существование.
   */
  private async assertChannelAccess(
    channelId: ChannelId,
    requester: { userId: Id<'user'>; role: UserRole },
  ): Promise<void> {
    const channel = await this.repository.findChannel(channelId);
    if (channel === undefined) throw notFound('Канал не найден');
    if (requester.role === 'admin' || requester.role === 'support') return;

    const client = await this.billing.findClientOwnedBy(requester.userId);
    if (client === undefined || client.id !== channel.clientId) {
      throw notFound('Канал не найден');
    }
  }

  private toAccount(credentials: SipCredentials): IssuedSipAccount {
    return {
      username: credentials.username,
      password: credentials.password,
      realm: this.realm,
    };
  }
}

function channelVariables(channel: ChannelRow): DirectoryUser['variables'] {
  const variables: Record<string, string> = {
    // По этой переменной запрос маршрута опознаёт канал: на узле знания о каналах нет.
    zvonix_channel: channel.id,
    zvonix_recording_required: channel.recordingRequired ? 'true' : 'false',
  };
  if (channel.callerId !== null) {
    variables['zvonix_caller_id'] = channel.callerId;
  }
  return variables;
}
