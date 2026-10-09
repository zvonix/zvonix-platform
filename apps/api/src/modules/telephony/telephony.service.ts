/**
 * Учётные записи SIP обеих сторон вызова (ADR-0009).
 *
 * Каталог отдаётся из control plane, а не лежит файлом на узле. Смысл ровно один:
 * заблокировали партнёра — его шлюз перестал регистрироваться при следующей же попытке,
 * без раскатки конфигурации и без перезапуска узла.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  dependencyUnavailable,
  internal as internalError,
  regionKeyOf,
  notFound,
  supportsPortRegistration,
  parseId,
  parseMsisdn,
  validationFailed,
  type ChannelStatus,
  type GatewayRegistrationMode,
  type GatewayState,
  type GatewayStatus,
  type GatewaySuspendedBy,
  type GatewayType,
  type Id,
  type Msisdn,
  type SimStatus,
  type TerminationKind,
  type UserRole,
} from '@zvonix/shared';
import { decryptSecret, encryptSecret, SIP_TRUNK_SECRET_PURPOSE } from '../../infra/secret-box.js';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingRepository } from '../billing/billing.repository.js';
import { CatalogRepository } from '../catalog/catalog.repository.js';
import { TariffService } from '../catalog/tariff.service.js';
import { OperatorResolverService } from '../catalog/operator-resolver.service.js';
import { directoryDocument, notFoundDocument, type DirectoryUser } from './directory-xml.js';
import { MAX_GATEWAY_PORTS } from './schemas.js';
import {
  issueSipCredentials,
  issueSipUsername,
  renewSipPassword,
  type SipCredentials,
} from './sip-credentials.js';
import {
  gatewayStateOf,
  TelephonyRepository,
  type AllowedOperatorRow,
  type ChannelId,
  type Executor,
  type ChannelRow,
  type GatewayId,
  type GatewayPortId,
  type GatewayPortRow,
  type GatewayRow,
  type PartnerId,
  type SimCandidate,
  type SimCardId,
  type SimCardRow,
  type SipTrunkRow,
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
  /** Через что уходит вызов по этому приоритету: SIM и транк — разные предложения. */
  readonly terminationKind: TerminationKind;
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

/** Сколько линий клиент заводит себе сам (ADR-0058). */
const OWN_CHANNELS_MAX = 5;

/** Учётная запись вместе с паролем. Пароль существует только здесь и только один раз. */
export interface IssuedSipAccount {
  readonly username: string;
  readonly password: string;
  readonly realm: string;
}

/** Вход линии GOIP (ADR-0054) — с портом, к которому он выдан. */
export interface IssuedPortAccount extends IssuedSipAccount {
  readonly portId: GatewayPortId;
  readonly portNumber: number;
}

@Injectable()
export class TelephonyService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: TelephonyRepository,
    private readonly billing: BillingRepository,
    private readonly audit: AuditService,
    private readonly resolver: OperatorResolverService,
    private readonly catalog: CatalogRepository,
    private readonly tariffs: TariffService,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('telephony');
  }

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
      /** Пусто — `gateway`, как до появления поля (ADR-0054). */
      registrationMode?: GatewayRegistrationMode;
    },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<{
    gateway: GatewayRow;
    account: IssuedSipAccount;
    portAccounts: IssuedPortAccount[];
  }> {
    const registrationMode = input.registrationMode ?? 'gateway';
    if (registrationMode === 'port' && !supportsPortRegistration(input.type)) {
      throw validationFailed('Вход по линиям бывает только у GOIP');
    }

    const credentials = issueSipCredentials('gateway', this.realm);
    // Порты 1…N заводятся вместе со шлюзом, одной транзакцией. Раньше число записывалось,
    // а портов не появлялось: партнёр указывал восемь и видел «портов не заведено»
    // (владелец, 2026-09-24). При входе по линиям тем же движением им выдаются входы:
    // пароли показываются один раз, и показать их надо там же, где шлюз добавлен.
    const { gateway, portAccounts } = await this.repository.transaction(async (tx) => {
      const created = await this.repository.createGateway(
        {
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
          registrationMode,
        },
        tx,
      );
      // У транка портов не бывает: SIM в нём нет.
      if (input.type === 'sip_trunk') return { gateway: created, portAccounts: [] };
      const ports = await this.repository.createPorts(
        created.id,
        Array.from({ length: input.portCount }, (_, index) => index + 1),
        tx,
      );
      return {
        gateway: created,
        portAccounts: registrationMode === 'port' ? await this.issuePortAccounts(ports, tx) : [],
      };
    });

    await this.audit.record({
      action: 'gateway.created',
      entityType: 'gateway',
      entityId: gateway.id,
      actorUserId,
      actorRole,
      // Ни пароля, ни хеша: журнал читают люди, которым они не нужны.
      after: {
        name: gateway.name,
        type: gateway.type,
        sip_username: gateway.sipUsername,
        port_count: input.type === 'sip_trunk' ? 0 : input.portCount,
        registration_mode: gateway.registrationMode,
      },
    });
    await this.recordPortAccounts(portAccounts, actorUserId, actorRole);

    return { gateway, account: this.toAccount(credentials), portAccounts };
  }

  /**
   * Смена способа подключения ([ADR-0054](../../../../../docs/adr/0054-vhod-po-liniyam-goip.md)).
   *
   * При переходе на вход по линиям портам без входа он выдаётся тут же, и пароли
   * возвращаются один раз: иначе после переключения партнёру пришлось бы искать
   * ещё одну кнопку, прежде чем линии смогут зарегистрироваться.
   *
   * Под блокировкой шлюза, как запись в порты (ADR-0048): выдача входов не должна
   * разойтись с одновременной сменой режима или списанием.
   */
  async setRegistrationMode(
    id: GatewayId,
    mode: GatewayRegistrationMode,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<{ gateway: GatewayRow; portAccounts: IssuedPortAccount[] }> {
    const result = await this.repository.transaction(async (tx) => {
      const gateway = await this.repository.lockGatewayForPorts(id, tx);
      if (gateway === undefined) throw notFound('Шлюз не найден');
      if (gateway.registrationMode === mode) {
        return { before: gateway, gateway, portAccounts: [] };
      }
      if (gateway.status === 'retired') throw conflict('Шлюз списан: настраивать нечего');
      if (mode === 'port' && !supportsPortRegistration(gateway.type)) {
        throw conflict('Вход по линиям бывает только у GOIP');
      }

      const updated = await this.repository.changeRegistrationMode(
        id,
        gateway.registrationMode,
        mode,
        tx,
      );
      if (updated === undefined) {
        throw conflict('Способ подключения успел измениться — обновите страницу');
      }
      const portAccounts =
        mode === 'port'
          ? await this.issuePortAccounts(
              await this.repository.lockPortsWithoutCredentials(id, tx),
              tx,
            )
          : [];
      return { before: gateway, gateway: updated, portAccounts };
    });

    if (result.before.registrationMode !== result.gateway.registrationMode) {
      await this.audit.record({
        action: 'gateway.registration_mode_changed',
        entityType: 'gateway',
        entityId: id,
        actorUserId,
        actorRole,
        before: { registration_mode: result.before.registrationMode },
        after: { registration_mode: result.gateway.registrationMode },
      });
    }
    await this.recordPortAccounts(result.portAccounts, actorUserId, actorRole);

    return { gateway: result.gateway, portAccounts: result.portAccounts };
  }

  /**
   * Входы всем портам шлюза, у которых их нет, — после «Добавить порты»
   * или для линий, пропущенных при переключении.
   *
   * Уже выданные не трогаются: перевыпуск входа — отдельное действие над одним портом,
   * он заставляет перенастраивать линию.
   */
  async issueMissingPortAccounts(
    gatewayId: GatewayId,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<IssuedPortAccount[]> {
    const accounts = await this.repository.transaction(async (tx) => {
      const gateway = await this.repository.lockGatewayForPorts(gatewayId, tx);
      if (gateway === undefined) throw notFound('Шлюз не найден');
      this.requirePortRegistration(gateway);
      return this.issuePortAccounts(
        await this.repository.lockPortsWithoutCredentials(gatewayId, tx),
        tx,
      );
    });
    await this.recordPortAccounts(accounts, actorUserId, actorRole);
    return accounts;
  }

  /**
   * Новый пароль одной линии: имя прежнее, регистрация линии стирается.
   *
   * Только пароль, как и обещает кнопка: имя уже введено в GOIP, и менять его значило
   * бы заставить перенастраивать два поля вместо одного (владелец, 2026-09-25).
   */
  async resetPortAccount(
    portId: GatewayPortId,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<IssuedPortAccount> {
    const found = await this.repository.findPort(portId);
    if (found === undefined) throw notFound('Порт не найден');

    const { before, account } = await this.repository.transaction(async (tx) => {
      const gateway = await this.repository.lockGatewayForPorts(found.gatewayId, tx);
      if (gateway === undefined) throw notFound('Шлюз не найден');
      this.requirePortRegistration(gateway);
      const port = await this.repository.lockPort(portId, tx);
      if (port === undefined) throw notFound('Порт не найден');
      const [issued] = await this.issuePortAccounts([port], tx);
      if (issued === undefined) throw new Error('Выдача входа не вернула учётную запись');
      return { before: port, account: issued };
    });

    // Выдан впервые — запись о выдаче; был — о новом пароле: одинаковое имя до и после
    // в записи о выдаче читалось бы как «ничего не произошло».
    if (before.sipUsername === null) {
      await this.recordPortAccounts([account], actorUserId, actorRole);
    } else {
      await this.audit.record({
        action: 'gateway_port.password_reset',
        entityType: 'gateway_port',
        entityId: account.portId,
        actorUserId,
        actorRole,
        after: { sip_username: account.username },
      });
    }
    return account;
  }

  /** Вход линии выдаётся только шлюзу со входом по линиям и не списанному. */
  private requirePortRegistration(gateway: GatewayRow): void {
    if (gateway.status === 'retired') throw conflict('Шлюз списан: настраивать нечего');
    if (gateway.registrationMode !== 'port') {
      // Вход, который каталог не отдаст, партнёр ввёл бы в устройство и не понял бы,
      // почему линия молчит (ADR-0054).
      throw conflict('Шлюз подключён одним входом — сначала переключите его на вход по линиям');
    }
  }

  /** Выпуск входов портам внутри транзакции вызывающего. Пароли — только в ответе. */
  private async issuePortAccounts(
    ports: readonly GatewayPortRow[],
    tx: Executor,
  ): Promise<IssuedPortAccount[]> {
    const accounts: IssuedPortAccount[] = [];
    for (const port of ports) {
      // У порта со входом — новый пароль к прежнему имени; без входа — вход целиком.
      const credentials =
        port.sipUsername === null
          ? issueSipCredentials('port', this.realm)
          : renewSipPassword(port.sipUsername, this.realm);
      const updated = await this.repository.setPortCredentials(
        port.id,
        credentials.username,
        credentials.a1Hash,
        tx,
      );
      if (updated === undefined) throw notFound('Порт не найден');
      accounts.push({
        ...this.toAccount(credentials),
        portId: port.id,
        portNumber: port.portNumber,
      });
    }
    return accounts;
  }

  /**
   * Каждый вход — своей записью по порту: историю линии ищут по её порту.
   * Ни пароля, ни хеша, только имя.
   */
  private async recordPortAccounts(
    accounts: readonly IssuedPortAccount[],
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<void> {
    for (const account of accounts) {
      await this.audit.record({
        action: 'gateway_port.credentials_issued',
        entityType: 'gateway_port',
        entityId: account.portId,
        actorUserId,
        actorRole,
        before: { sip_username: null },
        after: { sip_username: account.username },
      });
    }
  }

  /**
   * Новый пароль шлюза — **имя прежнее** (ADR-0054, ревизия 2026-09-25).
   *
   * Раньше менялось и имя: «оно засветилось в логах». Но имя не секрет, а кнопка
   * называлась «новый пароль» — партнёр вводил пароль и не понимал, почему шлюз молчит:
   * имя в устройстве осталось старым (владелец, 2026-09-25). Прежний пароль перестаёт
   * действовать сразу, регистрация стирается.
   */
  async resetGatewayCredentials(
    id: GatewayId,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<IssuedSipAccount> {
    const existing = await this.repository.findGateway(id);
    if (existing === undefined) throw notFound('Шлюз не найден');

    const credentials = renewSipPassword(existing.sipUsername, this.realm);
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
      // Имя прежнее — меняется пароль; самого пароля в журнале нет.
      after: { sip_username: updated.sipUsername, password_changed: true },
    });

    return this.toAccount(credentials);
  }

  /**
   * Смена состояния шлюза администратором.
   *
   * Переходы свободны, но источник отключения ставится всегда: `suspended` от
   * администратора — это `admin`. Так он и **запирает** шлюз, выключенный самим
   * партнёром: тот больше не включит его и не спишет
   * ([ADR-0047](../../../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md)).
   */
  async setGatewayStatus(
    id: GatewayId,
    status: GatewayStatus,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<GatewayRow> {
    const existing = await this.repository.findGateway(id);
    if (existing === undefined) throw notFound('Шлюз не найден');
    const from = gatewayStateOf(existing);

    if (status === 'retired') {
      return from.status === 'retired'
        ? existing
        : this.retireGateway(existing, from, actorUserId, actorRole);
    }

    // Списание окончательно и для площадки: порты освобождены, карты розданы по другим шлюзам.
    if (from.status === 'retired') {
      throw conflict('Шлюз списан навсегда — заведите новый');
    }

    const to: GatewayState =
      status === 'suspended' ? { status, suspendedBy: 'admin' } : { status, suspendedBy: null };
    return this.changeGatewayState(existing, from, to, actorUserId, actorRole);
  }

  /**
   * Смена состояния условием на прежнее — и запись в журнал вместе с источником.
   *
   * Тот же результат — ничего не меняется и не пишется. Не совпало прежнее — кто-то
   * успел раньше, и перезаписывать его решение нельзя.
   */
  private async changeGatewayState(
    existing: GatewayRow,
    from: GatewayState,
    to: GatewayState,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<GatewayRow> {
    if (from.status === to.status && from.suspendedBy === to.suspendedBy) return existing;

    const updated = await this.repository.transitionGateway(existing.id, from, to);
    if (updated === undefined) return this.rejectStaleGateway(existing.id);

    await this.audit.record({
      action: 'gateway.status_changed',
      entityType: 'gateway',
      entityId: existing.id,
      actorUserId,
      actorRole,
      before: stateForAudit(from),
      after: stateForAudit(to),
    });

    return updated;
  }

  /** Условие на прежнее состояние не совпало: шлюза нет — `404`, есть — его успели изменить. */
  private async rejectStaleGateway(id: GatewayId): Promise<never> {
    const current = await this.repository.findGateway(id);
    if (current === undefined) throw notFound('Шлюз не найден');
    throw conflict('Состояние шлюза успело измениться — обновите страницу');
  }

  /**
   * Списание шлюза освобождает его порты.
   *
   * Иначе карта в порту списанного шлюза становится неизвлекаемой: вынуть её нельзя —
   * портов списанного шлюза в кабинете нет; списать нельзя — «стоит в порту»;
   * поставить в другой порт нельзя — «уже стоит в другом». При этом она занимает
   * место в пределе на количество, и партнёр ничего не может с этим сделать.
   *
   * Молчаливым это освобождение не выглядит, и в этом разница с картой: у карты порт
   * остаётся, и её исчезновение оттуда было бы загадкой, а здесь порт уничтожает сам
   * партнёр — необратимым действием, о котором кабинет спрашивает второй раз и там же
   * называет число карт ([ADR-0043](../../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md)).
   */
  private async retireGateway(
    existing: GatewayRow,
    from: GatewayState,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<GatewayRow> {
    const result = await this.repository.retireGatewayFreeingPorts(existing.id, from);
    if (result === undefined) return this.rejectStaleGateway(existing.id);

    // Каждая карта отдельной записью, а не числом в записи о шлюзе: искать историю
    // карты будут по её порту, и «здесь сняли пять» на этот вопрос не отвечает.
    for (const port of result.freed) {
      await this.audit.record({
        action: 'gateway_port.sim_removed',
        entityType: 'gateway_port',
        entityId: port.portId,
        actorUserId,
        actorRole,
        before: { sim_card_id: port.simCardId },
        after: { sim_card_id: null, reason: 'gateway.retired' },
      });
    }

    await this.audit.record({
      action: 'gateway.status_changed',
      entityType: 'gateway',
      entityId: existing.id,
      actorUserId,
      actorRole,
      before: stateForAudit(from),
      after: {
        ...stateForAudit({ status: 'retired', suspendedBy: null }),
        freed_sims: result.freed.length,
      },
    });

    return result.gateway;
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
      /** Заводит администратор — `pending`; клиент, получающий линию сам, — `active` (ADR-0058). */
      status?: ChannelStatus;
    },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<{ channel: ChannelRow; account: IssuedSipAccount }> {
    const credentials = issueSipCredentials('channel', this.realm);
    const channel = await this.repository.createChannel({
      clientId: input.clientId,
      name: input.name,
      status: input.status ?? 'pending',
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

  /**
   * Линия, которую клиент заводит себе сам ([ADR-0058](../../../../../docs/adr/0058-klient-sam-poluchaet-liniyu.md)).
   *
   * Сразу `active`: допуск клиента уже состоялся, второй проверки нет. Клиент не в
   * состоянии `active` линий не заводит, и линий не больше `OWN_CHANNELS_MAX`.
   */
  async createOwnChannel(
    requester: { userId: Id<'user'>; role: UserRole },
    name: string | undefined,
  ): Promise<{ channel: ChannelRow; account: IssuedSipAccount }> {
    const own = await this.billing.findClientOwnedBy(requester.userId);
    const client = own === undefined ? undefined : await this.billing.findClient(own.id);
    if (client === undefined) throw notFound('Клиент не найден');
    if (client.status !== 'active') {
      throw conflict('Клиент не работает — линию завести нельзя');
    }
    const existing = await this.repository.listChannels(client.id);
    if (existing.length >= OWN_CHANNELS_MAX) {
      throw conflict(`Линий уже ${String(OWN_CHANNELS_MAX)} — больше завести нельзя`);
    }
    return this.createChannel(
      {
        clientId: client.id,
        name: name ?? `Линия ${String(existing.length + 1)}`,
        recordingRequired: false,
        callerId: null,
        status: 'active',
      },
      requester.userId,
      requester.role,
    );
  }

  /** Новый доступ своей линии: чужая линия — `404` (ADR-0058). */
  async resetOwnChannelCredentials(
    id: ChannelId,
    requester: { userId: Id<'user'>; role: UserRole },
  ): Promise<IssuedSipAccount> {
    await this.assertChannelAccess(id, requester);
    return this.resetChannelCredentials(id, requester.userId, requester.role);
  }

  /**
   * Правка настроек канала.
   *
   * До появления метода название, требование записи и номер для показа задавались
   * **только при заведении**. Сменить их можно было единственным способом — завести
   * канал заново, а это новые учётные данные SIP и перенастройка АТС у клиента.
   * То есть техническая цена косметической правки была непропорциональной.
   *
   * Учётных данных правка не касается: регистрация клиентской АТС от переименования
   * канала падать не должна.
   *
   * Смена `recordingRequired` действует на **последующие** вызовы. Уже записанное
   * никуда не девается, а включение записи сужает выбор партнёров: канал с записью
   * не уходит на шлюзы типа `android`, где она технически невозможна
   * ([ADR-0012](../../../../../docs/adr/0012-mobilnoe-prilozhenie.md)).
   */
  async updateChannel(
    id: ChannelId,
    changes: { name?: string; recordingRequired?: boolean; callerId?: string | null },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<ChannelRow> {
    const existing = await this.repository.findChannel(id);
    if (existing === undefined) throw notFound('Канал не найден');

    const updated = await this.repository.updateChannel(id, changes);
    if (updated === undefined) throw notFound('Канал не найден');

    await this.audit.record({
      action: 'channel.updated',
      entityType: 'channel',
      entityId: id,
      actorUserId,
      actorRole,
      before: {
        name: existing.name,
        recording_required: existing.recordingRequired,
        caller_id: existing.callerId,
      },
      after: {
        name: updated.name,
        recording_required: updated.recordingRequired,
        caller_id: updated.callerId,
      },
    });

    return updated;
  }

  /**
   * Перевыпуск учётных данных канала.
   *
   * Симметрично шлюзу, и по той же причине: пароль SIP восстановить неоткуда, а утёкший
   * пароль канала — это чужие вызовы **за счёт клиента**. Без этого пути единственным
   * ответом на утечку было бы отключение канала целиком.
   *
   * Меняется и имя, и пароль: имя уже засветилось в записи регистрации на узле
   * и в логах, а перенастраивать АТС клиенту всё равно придётся — пусть меняется всё разом.
   */
  async resetChannelCredentials(
    id: ChannelId,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<IssuedSipAccount> {
    const existing = await this.repository.findChannel(id);
    if (existing === undefined) throw notFound('Канал не найден');

    const credentials = issueSipCredentials('channel', this.realm);
    const updated = await this.repository.replaceChannelCredentials(
      id,
      credentials.username,
      credentials.a1Hash,
    );
    if (updated === undefined) throw notFound('Канал не найден');

    await this.audit.record({
      action: 'channel.credentials_reset',
      entityType: 'channel',
      entityId: id,
      actorUserId,
      actorRole,
      before: { sip_username: existing.sipUsername },
      after: { sip_username: updated.sipUsername },
    });

    return this.toAccount(credentials);
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
      /** `null` — оператора называет резолвер по номеру; не назвал — отказ. */
      operatorId: Id<'operator'> | null;
      msisdn: Msisdn;
      iccid: string | null;
      activatedAt: Date | null;
    },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<SimCardRow> {
    const resolution = await this.resolver.resolve(input.msisdn);
    let confirmedAt: Date | null = null;
    let operatorId = input.operatorId;

    if (operatorId === null) {
      // Спрашивать у партнёра то, что площадка узнаёт по номеру сама, значило бы только
      // дать ему ошибиться. Подтверждённый источник называет того, кто обслуживает номер;
      // без него — владелец диапазона по плану нумерации, и карта заводится
      // с неподтверждённым оператором, как и с оператором, названным партнёром; включается
      // она и так (владелец, 2026-09-25). Нет и владельца — отказ, а не догадка.
      const known = resolution.serving ?? resolution.rangeOwner;
      if (known === undefined) {
        throw dependencyUnavailable('Не удалось определить оператора номера', {
          details: {
            remedy:
              'Номера нет в плане нумерации площадки. Проверьте его; если он верный — напишите площадке.',
          },
        });
      }
      operatorId = known.id;
    }

    if (resolution.confirmed && resolution.serving !== undefined) {
      if (resolution.serving.id !== operatorId) {
        throw validationFailed('Объявленный оператор не совпадает с фактическим', {
          details: {
            declared_operator_id: operatorId,
            actual_operator_id: resolution.serving.id,
            actual_operator: resolution.serving.name,
          },
        });
      }
      confirmedAt = new Date();
    }

    const sim = await this.repository.createSim({
      partnerId: input.partnerId,
      operatorId,
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
    // Списание окончательно и для площадки (DOMAIN.md, «Жизненные циклы»): на карту
    // ссылаются CDR, а вернуть её — значит ожить записи, у которой порт давно освобождён.
    if (existing.status === 'retired' && status !== 'retired') {
      throw conflict('SIM списана навсегда — заведите новую');
    }

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
  /**
   * Тариф шлюза — для всех его SIM без своего (ADR-0056). Тариф — только этого же
   * партнёра: чужой тариф — чужие цены на своей карте. Проверка и запись — одна
   * транзакция; удалить тариф, пока его выбирают, не даст внешний ключ.
   */
  async setGatewayTariff(
    id: GatewayId,
    tariffId: Id<'partnerTariff'> | null,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<GatewayRow> {
    const { before, after } = await this.repository.transaction(async (tx) => {
      const gateway = await this.repository.lockGatewayForPorts(id, tx);
      if (gateway === undefined) throw notFound('Шлюз не найден');
      if (gateway.status === 'retired') throw conflict('Шлюз списан: настраивать нечего');
      if (tariffId !== null) await this.tariffs.requireTariffOf(gateway.partnerId, tariffId, tx);
      const updated = await this.repository.setGatewayTariff(id, tariffId, tx);
      if (updated === undefined) throw notFound('Шлюз не найден');
      return { before: gateway, after: updated };
    });
    if (before.tariffId !== after.tariffId) {
      await this.audit.record({
        action: 'gateway.tariff_changed',
        entityType: 'gateway',
        entityId: id,
        actorUserId,
        actorRole,
        before: { tariff_id: before.tariffId },
        after: { tariff_id: after.tariffId },
      });
    }
    return after;
  }

  /** Свой тариф SIM (ADR-0056); `null` — как у шлюза, в котором она стоит. */
  async setSimTariff(
    id: SimCardId,
    tariffId: Id<'partnerTariff'> | null,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<SimCardRow> {
    const { before, after } = await this.repository.transaction(async (tx) => {
      const sim = await this.repository.lockSimCard(id, tx);
      if (sim === undefined) throw notFound('SIM не найдена');
      if (sim.status === 'retired') throw conflict('Карта удалена: настраивать нечего');
      if (tariffId !== null) await this.tariffs.requireTariffOf(sim.partnerId, tariffId, tx);
      const updated = await this.repository.setSimTariff(id, tariffId, tx);
      if (updated === undefined) throw notFound('SIM не найдена');
      return { before: sim, after: updated };
    });
    if (before.tariffId !== after.tariffId) {
      await this.audit.record({
        action: 'sim.tariff_changed',
        entityType: 'sim_card',
        entityId: id,
        actorUserId,
        actorRole,
        before: { tariff_id: before.tariffId },
        after: { tariff_id: after.tariffId },
      });
    }
    return after;
  }

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
    const [port] = await this.addPorts(gatewayId, { portNumber }, actorUserId, actorRole);
    if (port === undefined) throw new Error('Вставка порта не вернула строку');
    return port;
  }

  /**
   * Порт с заданным номером или несколько следующих по порядку.
   *
   * «Следующие» — после наибольшего заведённого, под той же блокировкой шлюза, что
   * и проверка: два одновременных «добавить четыре» иначе посчитали бы от одного
   * и того же номера, и второе упало бы на уникальности.
   */
  async addPorts(
    gatewayId: GatewayId,
    spec: { portNumber: number } | { count: number },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<GatewayPortRow[]> {
    // Под блокировкой шлюза: порт, заведённый в миг списания, остался бы у списанного
    // шлюза (ADR-0048).
    const ports = await this.repository.transaction(async (tx) => {
      const gateway = await this.repository.lockGatewayForPorts(gatewayId, tx);
      if (gateway === undefined) throw notFound('Шлюз не найден');
      // У транка портов не бывает: к провайдеру регистрируемся мы, а SIM в нём нет.
      // Заведённый порт был бы строкой, в которую вставляется карта, не звонящая никуда.
      if (gateway.type === 'sip_trunk') throw conflict('У SIP-транка портов нет');
      // Списанный шлюз портов не держит (ADR-0043, «Ревизия»): новый порт стал бы местом
      // для карты, которой не достать.
      if (gateway.status === 'retired') throw conflict('Шлюз списан: заводить порт некуда');

      if ('portNumber' in spec)
        return this.repository.createPorts(gatewayId, [spec.portNumber], tx);
      const last = await this.repository.lastPortNumber(gatewayId, tx);
      if (last + spec.count > MAX_GATEWAY_PORTS) {
        throw conflict(`У шлюза не бывает больше ${String(MAX_GATEWAY_PORTS)} портов`, {
          details: { last_port_number: last },
        });
      }
      return this.repository.createPorts(
        gatewayId,
        Array.from({ length: spec.count }, (_, index) => last + index + 1),
        tx,
      );
    });

    for (const port of ports) {
      await this.audit.record({
        action: 'gateway_port.created',
        entityType: 'gateway_port',
        entityId: port.id,
        actorUserId,
        actorRole,
        after: { gateway_id: gatewayId, port_number: port.portNumber },
      });
    }
    return ports;
  }

  /**
   * Ставит SIM в порт или вынимает её.
   *
   * SIM и порт обязаны принадлежать одному партнёру: иначе чужая SIM оказалась бы
   * в чужом шлюзе, а выручка от вызова ушла бы не тому.
   *
   * Одной транзакцией с блокировками «шлюз → порт → карта», и все проверки — по запертым
   * строкам ([ADR-0048](../../../../../docs/adr/0048-poryadok-blokirovok-portov.md)).
   * Порознь установка, прочитавшая шлюз ещё включённым, дописывала карту в порт уже
   * списанного шлюза, а «вынуть» во время списания давало вторую запись о снятии.
   *
   * Не изменилось ничего — повтор той же установки или «вынуть» из пустого порта — ничего
   * и не пишется, ни в базу, ни в журнал: повтор не отказ, но и не событие.
   */
  async assignSimToPort(
    portId: GatewayPortId,
    simCardId: SimCardId | null,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<GatewayPortRow> {
    // Шлюз у порта не меняется никогда, поэтому его можно узнать до блокировок —
    // а запирать нужно начиная со шлюза.
    const found = await this.repository.findPort(portId);
    if (found === undefined) throw notFound('Порт не найден');

    const { before, after } = await this.repository.transaction(async (tx) => {
      const gateway = await this.repository.lockGatewayForPorts(found.gatewayId, tx);
      if (gateway === undefined) throw notFound('Шлюз не найден');
      const port = await this.repository.lockPort(portId, tx);
      if (port === undefined) throw notFound('Порт не найден');

      if (port.simCardId === simCardId) return { before: port, after: port };

      // Вынуть (`null`) можно всегда, и из порта списанного шлюза тоже: строка, оставшаяся
      // от прежних правил, не должна оказаться неисправимой.
      if (simCardId !== null) {
        // В порт списанного шлюза ставить нечего: порта больше нет.
        if (gateway.status === 'retired') {
          throw conflict('Шлюз списан: ставить карту в его порт некуда');
        }

        const sim = await this.repository.lockSimCard(simCardId, tx);
        if (sim === undefined) throw notFound('SIM не найдена');
        if (sim.partnerId !== gateway.partnerId) {
          throw validationFailed('SIM и шлюз принадлежат разным партнёрам');
        }
        // Списание окончательно: в порту карта ожила бы для маршрутизации.
        if (sim.status === 'retired') throw conflict('SIM списана — ставить её в порт нельзя');

        // «Одна SIM в одном порту» держит частичный уникальный индекс, но он отвечает
        // «такая запись уже существует» — по такому ответу непонятно ни что занято,
        // ни где искать. Карта заперта, поэтому чтение видит и установку, завершившуюся
        // только что; индекс остаётся последним рубежом для путей в обход этого.
        const occupied = await this.repository.findPortBySim(simCardId, tx);
        if (occupied !== undefined) {
          throw conflict('Эта SIM уже стоит в другом порту', {
            details: { port_id: occupied.id, gateway_id: occupied.gatewayId },
          });
        }
      }

      const updated = await this.repository.setPortSim(portId, simCardId, tx);
      if (updated === undefined) throw notFound('Порт не найден');
      return { before: port, after: updated };
    });

    if (before.simCardId !== after.simCardId) {
      await this.audit.record({
        action: simCardId === null ? 'gateway_port.sim_removed' : 'gateway_port.sim_installed',
        entityType: 'gateway_port',
        entityId: portId,
        actorUserId,
        actorRole,
        before: { sim_card_id: before.simCardId },
        after: { sim_card_id: after.simCardId },
      });
    }

    return after;
  }

  async listPorts(gatewayId: GatewayId): Promise<GatewayPortRow[]> {
    return this.repository.listPorts(gatewayId);
  }

  /** Все порты партнёра — для его кабинета, одним запросом вместо запроса на шлюз. */
  async listPartnerPorts(partnerId: Id<'partner'>): Promise<GatewayPortRow[]> {
    return this.repository.listPartnerPorts(partnerId);
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
    const found = await this.repository.findSimCandidates({
      excludeRecordingIncapable: requiresRecording,
      // Без региона покрытие не проверяется: вопрос «какие SIM вообще подходят»
      // задаётся и тогда, когда номера ещё нет. С регионом — то же, что увидит
      // маршрутизация (ADR-0022).
      ...(region === undefined ? {} : { region }),
    });
    // Под оператора подходит SIM, в тарифе которой есть цена на него (ADR-0056) —
    // тот же отсев, что у маршрутизации.
    const rates = await this.tariffs.ratesFor(
      found.map((candidate) => ({
        partnerId: candidate.gateway.partnerId,
        tariffId: candidate.sim.tariffId ?? candidate.gateway.tariffId,
        terminationKind: 'sim',
      })),
      operatorId,
      region ?? null,
      new Date(),
    );
    return found.filter((_, index) => rates[index] !== undefined);
  }

  // --- SIP-транки (ADR-0039) ---------------------------------------------------

  /**
   * Заводит транк партнёра.
   *
   * Транк привязывается к **узлу** сразу и обязательно: к провайдеру регистрируемся мы,
   * и регистрация принадлежит конкретной машине. Транк без узла означал бы ёмкость,
   * которую некому поднять.
   *
   * Пароль провайдера **шифруется**, а не хешируется: без открытого значения
   * к провайдеру не зарегистрироваться. Это единственный пароль в проекте, который
   * платформа обязана уметь предъявить наружу.
   */
  async createTrunk(
    draft: {
      partnerId: PartnerId;
      nodeId: Id<'node'>;
      name: string;
      proxyHost: string;
      registersOutbound: boolean;
      outboundUsername: string | null;
      outboundSecret: string | null;
      maxConcurrentCalls: number;
    },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<{ gateway: GatewayRow; trunk: SipTrunkRow }> {
    const created = await this.repository.createTrunk(
      {
        partnerId: draft.partnerId,
        nodeId: draft.nodeId,
        name: draft.name,
        sipUsername: issueSipUsername('gateway'),
      },
      {
        proxyHost: draft.proxyHost,
        registersOutbound: draft.registersOutbound,
        outboundUsername: draft.outboundUsername,
        outboundSecret: this.sealSecret(draft.outboundSecret),
        maxConcurrentCalls: draft.maxConcurrentCalls,
      },
    );

    await this.audit.record({
      action: 'sip_trunk.created',
      entityType: 'gateway',
      entityId: created.gateway.id,
      actorUserId,
      actorRole,
      // Пароля провайдера в журнале нет ни в каком виде: остаётся факт, что он задан.
      after: {
        partner_id: draft.partnerId,
        node_id: draft.nodeId,
        name: draft.name,
        proxy_host: draft.proxyHost,
        registers_outbound: draft.registersOutbound,
        max_concurrent_calls: draft.maxConcurrentCalls,
        has_secret: draft.outboundSecret !== null,
      },
    });

    return created;
  }

  async listTrunks(partnerId?: PartnerId): Promise<{ gateway: GatewayRow; trunk: SipTrunkRow }[]> {
    return this.repository.listTrunks(partnerId);
  }

  /**
   * Правит настройки транка.
   *
   * Пароль меняется только явной передачей: «поля нет» означает «не трогать», иначе
   * правка одного лишь адреса стирала бы учётные данные, и транк переставал бы
   * подниматься без единого сообщения.
   */
  async updateTrunk(
    gatewayId: GatewayId,
    changes: {
      proxyHost?: string;
      registersOutbound?: boolean;
      outboundUsername?: string | null;
      outboundSecret?: string | null;
      maxConcurrentCalls?: number;
    },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<{ gateway: GatewayRow; trunk: SipTrunkRow }> {
    const before = await this.repository.findTrunk(gatewayId);
    if (before === undefined) throw notFound('Транк не найден');

    const updated = await this.repository.updateTrunk(gatewayId, {
      ...(changes.proxyHost === undefined ? {} : { proxyHost: changes.proxyHost }),
      ...(changes.registersOutbound === undefined
        ? {}
        : { registersOutbound: changes.registersOutbound }),
      ...(changes.outboundUsername === undefined
        ? {}
        : { outboundUsername: changes.outboundUsername }),
      ...(changes.outboundSecret === undefined
        ? {}
        : { outboundSecret: this.sealSecret(changes.outboundSecret) }),
      ...(changes.maxConcurrentCalls === undefined
        ? {}
        : { maxConcurrentCalls: changes.maxConcurrentCalls }),
    });
    if (updated === undefined) throw notFound('Транк не найден');

    await this.audit.record({
      action: 'sip_trunk.updated',
      entityType: 'gateway',
      entityId: gatewayId,
      actorUserId,
      actorRole,
      before: toTrunkAudit(before.trunk),
      after: toTrunkAudit(updated),
    });

    return { gateway: before.gateway, trunk: updated };
  }

  /**
   * Транки, которые узел обязан поднять, — **с расшифрованными паролями**.
   *
   * Единственное место, где пароль провайдера покидает базу в открытом виде, и уходит
   * он только узлу: без него зарегистрироваться нельзя. В ответ человеку он
   * не попадает никогда.
   */
  async nodeTrunks(nodeId: Id<'node'>): Promise<
    {
      name: string;
      proxyHost: string;
      registersOutbound: boolean;
      username: string | null;
      password: string | null;
    }[]
  > {
    const rows = await this.repository.listNodeTrunks(nodeId);
    return rows.map((row) => ({
      name: row.gateway.sipUsername,
      proxyHost: row.trunk.proxyHost,
      registersOutbound: row.trunk.registersOutbound,
      username: row.trunk.outboundUsername,
      password: this.openSecret(row.trunk.outboundSecret, row.gateway.id),
    }));
  }

  /** Пароль провайдера в базе — только зашифрованным. Пусто остаётся пустым. */
  private sealSecret(plain: string | null): string | null {
    if (plain === null || plain === '') return null;
    return encryptSecret(plain, this.config.SECRET_KEY, SIP_TRUNK_SECRET_PURPOSE);
  }

  /**
   * Расшифровка пароля провайдера.
   *
   * Неудача не роняет ответ целиком: сменился `SECRET_KEY` или испорчены данные,
   * и остальные транки узла при этом исправны. Молчать тоже нельзя — транк без пароля
   * не поднимется, а причина иначе не видна ниоткуда.
   */
  private openSecret(stored: string | null, gatewayId: GatewayId): string | null {
    if (stored === null) return null;
    try {
      return decryptSecret(stored, this.config.SECRET_KEY, SIP_TRUNK_SECRET_PURPOSE);
    } catch (cause) {
      this.logger.error('Пароль транка не расшифровывается', cause, { gateway_id: gatewayId });
      return null;
    }
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
    // Хеш пуст только у транка, а транк отбором уже отсеян. Проверка здесь не про
    // ожидаемый случай, а про рассогласование данных: отдать каталог без хеша значит
    // впустить кого угодно под этим именем.
    if (gateway !== undefined && gateway.a1Hash !== null) {
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

    const line = await this.repository.findRegistrablePort(username);
    if (line !== undefined && line.port.sipUsername !== null && line.port.a1Hash !== null) {
      await this.repository.recordPortRegistration(line.port.id, nodeId, new Date());
      return directoryDocument(this.realm, {
        username: line.port.sipUsername,
        a1Hash: line.port.a1Hash,
        variables: {
          zvonix_gateway: line.gateway.id,
          zvonix_gateway_type: line.gateway.type,
          zvonix_gateway_port: line.port.id,
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
        terminationKind: row.terminationKind,
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
    entries: readonly { aliasId: string; terminationKind: TerminationKind; priority: number }[],
    requester: { userId: Id<'user'>; role: UserRole },
  ): Promise<PartnerPriorityView[]> {
    await this.assertChannelAccess(channelId, requester);

    const seen = new Set<string>();
    const resolved: {
      partnerId: Id<'partner'>;
      terminationKind: TerminationKind;
      priority: number;
    }[] = [];

    for (const entry of entries) {
      // Ключ — предложение, а не партнёр: SIM и транк одного партнёра это две разные
      // строки с разными ценами, и запрещать их вместе значило бы запретить сам смысл
      // ([ADR-0040](../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)).
      const key = `${entry.aliasId}:${entry.terminationKind}`;
      if (seen.has(key)) {
        throw validationFailed('Одно и то же предложение указано дважды');
      }
      seen.add(key);

      const alias = await this.billing.findAliasById(parseId(entry.aliasId, 'partnerAlias'));
      // `not_found`, а не `validation_failed`: несуществующий псевдоним и чужой
      // выглядят для вызывающего одинаково, и по разнице ответов их перебирать нельзя.
      if (alias === undefined) throw notFound('Партнёр не найден');

      resolved.push({
        partnerId: alias.partnerId,
        terminationKind: entry.terminationKind,
        priority: entry.priority,
      });
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
      // Основной ключ строки — первый из набора: партнёр объявляет регионы по одному,
      // и написавший официальное «Кемеровская область - Кузбасс» получит `кемеровская`,
      // которое совпадёт с набором диапазона (ADR-0033).
      const regionKey = regionKeyOf(region);
      // «Область» или «край» сами по себе региона не называют, а пустой ключ совпал бы
      // с другим пустым и связал два разных региона.
      if (regionKey === null) {
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

  // --- Собственный контур партнёра (ADR-0043) --------------------------------

  /**
   * Шлюз принадлежит этому партнёру — иначе для него его не существует.
   *
   * Отказ `404`, а не `403`: `403` сообщил бы, что объект есть и он чужой, а партнёр
   * не должен узнавать даже этого. Ту же границу с другой стороны держит
   * [ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md).
   *
   * **Свой транк — тоже `404`.** Он лежит в той же таблице, но партнёру только
   * показывается: заводит и настраивает его площадка, он привязан к её узлу. Без этой
   * проверки через пути шлюзов партнёр выключал транк, перевыпускал ему доступ
   * и заводил порты ([ADR-0047](../../../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md)).
   */
  async requireOwnGateway(id: GatewayId, partnerId: PartnerId): Promise<GatewayRow> {
    const gateway = await this.repository.findGateway(id);
    if (!isOwnPartnerGateway(gateway, partnerId)) throw notFound('Шлюз не найден');
    return gateway;
  }

  /** Вес и приоритет карты; карта уже проверена как своя. */
  async setSimRank(
    id: SimCardId,
    rank: { weight?: number | undefined; priority?: number | undefined },
  ): Promise<SimCardRow> {
    const sim = await this.repository.setSimRank(id, {
      ...(rank.weight === undefined ? {} : { weight: rank.weight }),
      ...(rank.priority === undefined ? {} : { priority: rank.priority }),
    });
    if (sim === undefined) throw notFound('SIM не найдена');
    return sim;
  }

  async requireOwnSim(id: SimCardId, partnerId: PartnerId): Promise<SimCardRow> {
    const sim = await this.repository.findSim(id);
    if (sim === undefined || sim.partnerId !== partnerId) throw notFound('SIM не найдена');
    return sim;
  }

  /** Порт свой, если свой шлюз, которому он принадлежит. */
  async requireOwnPort(id: GatewayPortId, partnerId: PartnerId): Promise<GatewayPortRow> {
    const port = await this.repository.findPort(id);
    if (port === undefined) throw notFound('Порт не найден');

    const gateway = await this.repository.findGateway(port.gatewayId);
    // Отказ называется портом, а не шлюзом: спрашивали про порт, и чужой шлюз
    // за ним — не то, о чём партнёру следует узнать.
    if (!isOwnPartnerGateway(gateway, partnerId)) throw notFound('Порт не найден');
    return port;
  }

  /**
   * Заведение шлюза партнёром — с пределом на количество.
   *
   * Предел не про злой умысел: до собственного контура объём ограничивал
   * администратор тем, что печатал руками, и с его уходом не осталось ничего
   * ([ADR-0043](../../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md)).
   * Списанное не считается — предел про то, что стоит у партнёра сейчас.
   *
   * Счёт и вставка идут разными запросами, поэтому предел ограничивает порядок,
   * а не точное число: пачка одновременных обращений успевает сосчитать одно и то же
   * и перескочить его на свою глубину — не больше, чем пропустит предел частоты
   * изменений ([ADR-0041](../../../../../docs/adr/0041-predel-chastoty-izmeneniy.md)),
   * и ровно один раз: следующий счёт уже видит перебор. Запирать заведение ради
   * этого не стоит — предел здесь против сорвавшегося сценария, а тот упирается
   * в порядок величины, а не в конкретное число.
   */
  async createOwnGateway(
    input: {
      partnerId: PartnerId;
      name: string;
      type: GatewayType;
      model: string | null;
      portCount: number;
      registrationMode?: GatewayRegistrationMode;
    },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): ReturnType<TelephonyService['createGateway']> {
    const limit = this.config.PARTNER_GATEWAY_LIMIT;
    if (limit > 0 && (await this.repository.countGateways(input.partnerId)) >= limit) {
      throw conflict('Больше шлюзов завести нельзя', {
        details: { limit, remedy: 'Спишите неиспользуемые или напишите площадке.' },
      });
    }
    return this.createGateway(input, actorUserId, actorRole);
  }

  /** То же для карты: предел свой, потому что карт у партнёра на порядок больше. */
  async createOwnSim(
    input: {
      partnerId: PartnerId;
      operatorId: Id<'operator'> | null;
      msisdn: Msisdn;
      iccid: string | null;
      activatedAt: Date | null;
    },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<SimCardRow> {
    const limit = this.config.PARTNER_SIM_LIMIT;
    if (limit > 0 && (await this.repository.countSims(input.partnerId)) >= limit) {
      throw conflict('Больше SIM завести нельзя', {
        details: { limit, remedy: 'Спишите неиспользуемые или напишите площадке.' },
      });
    }
    // Придержанную или заблокированную площадкой карту не обойти, заведя её номер заново:
    // новая запись пришла бы без решения площадки (ADR-0047).
    await this.rejectHeldNumber(input.partnerId, input.msisdn);
    return this.createSim(input, actorUserId, actorRole);
  }

  /**
   * Номер придержан или заблокирован площадкой на какой-то записи этого партнёра — `409`.
   *
   * Номер не уникален ([ADR-0043](../../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md),
   * «Ревизия»), а карта за ним одна: новая или вторая запись того же номера вернула бы её
   * в работу без решения площадки ([ADR-0047](../../../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md),
   * «Ревизия»). Проверка без блокировки: придержание в те же миллисекунды не ловится —
   * принятая цена, записанная там же.
   */
  private async rejectHeldNumber(partnerId: PartnerId, msisdn: Msisdn): Promise<void> {
    if (await this.repository.hasHeldSim(partnerId, msisdn)) {
      throw conflict('Карта с этим номером придержана или заблокирована площадкой', {
        details: { remedy: 'Включить её может только администратор — напишите площадке.' },
      });
    }
  }

  /**
   * Партнёр распоряжается **своим** оборудованием — но не снимает отключение,
   * поставленное площадкой ([ADR-0047](../../../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md)).
   *
   * - **Своё выключение** партнёр снимает сам: включает обратно или списывает.
   * - **Отключение администратором или порогом** — нет, ни включением, ни списанием:
   *   иначе рычаг площадки снимался бы тем, против кого он поставлен, а «списал — завёл
   *   новый» обходил бы его в два шага.
   * - **Выключить можно только включённый.** У `pending` выключать нечего.
   * - **Списывает партнёр сам:** железо у него, и когда оно уехало, знает об этом он
   *   ([ADR-0043](../../../../../docs/adr/0043-partnyor-zavodit-svoyo-oborudovanie.md)).
   */
  async setOwnGatewayStatus(
    id: GatewayId,
    partnerId: PartnerId,
    status: 'active' | 'suspended' | 'retired',
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<GatewayRow> {
    const gateway = await this.requireOwnGateway(id, partnerId);
    const from = gatewayStateOf(gateway);

    if (from.status === 'retired') {
      throw conflict('Шлюз списан: заведите новый');
    }
    if (from.status === 'suspended' && from.suspendedBy !== 'partner') {
      throw from.suspendedBy === 'failure_threshold'
        ? conflict('Шлюз отключён автоматически: много неудачных вызовов', {
            details: {
              remedy: 'Проверьте оборудование и напишите площадке — включит администратор.',
            },
          })
        : conflict('Шлюз отключён площадкой — распорядиться им может только администратор', {
            details: { remedy: 'Напишите площадке.' },
          });
    }

    if (status === 'retired') {
      return this.retireGateway(gateway, from, actorUserId, actorRole);
    }
    if (status === 'suspended' && from.status === 'pending') {
      throw conflict('Шлюз ещё не включён — выключать нечего');
    }
    const to: GatewayState =
      status === 'suspended' ? { status, suspendedBy: 'partner' } : { status, suspendedBy: null };
    return this.changeGatewayState(gateway, from, to, actorUserId, actorRole);
  }

  /**
   * Списание своей карты.
   *
   * Стоящую в порту не списать: сначала выньте. Молча вынуть за партнёра было бы
   * удобнее ровно один раз — и непонятно во все остальные, когда карта исчезла
   * из порта сама.
   *
   * Заблокированную площадкой — тоже не списать: это её рычаг, и снимать его
   * списанием значило бы обходить.
   *
   * Проверки — под блокировкой карты
   * ([ADR-0048](../../../../../docs/adr/0048-poryadok-blokirovok-portov.md)): установка
   * в порт и придержание площадкой дожидаются списания, а списание — их. Порознь карта,
   * поставленная в порт в миг списания, оказывалась списанной в порту, а придержание,
   * поставленное в тот же миг, затиралось.
   */
  async retireOwnSim(
    id: SimCardId,
    partnerId: PartnerId,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<SimCardRow> {
    await this.requireOwnSim(id, partnerId);

    const { before, after } = await this.repository.transaction(async (tx) => {
      const sim = await this.repository.lockSimCard(id, tx);
      if (sim === undefined) throw notFound('SIM не найдена');
      if (sim.status === 'retired') return { before: sim, after: sim };
      // Придержанную — тоже: «списал — завёл заново» обходил бы порог так же, как блокировку
      // (ADR-0047).
      if (sim.status === 'blocked' || sim.status === 'throttled') {
        throw conflict(
          sim.status === 'blocked'
            ? 'Карта заблокирована площадкой — распорядиться ею может только администратор'
            : 'Карта придержана площадкой — распорядиться ею может только администратор',
        );
      }

      const port = await this.repository.findPortBySim(id, tx);
      if (port !== undefined) {
        throw conflict('Карта стоит в порту', {
          details: { port_number: port.portNumber, remedy: 'Сначала выньте её из порта.' },
        });
      }

      const updated = await this.repository.transitionSimStatus(id, sim.status, 'retired', tx);
      if (updated === undefined) throw notFound('SIM не найдена');
      return { before: sim, after: updated };
    });

    if (before.status !== after.status) {
      await this.audit.record({
        action: 'sim.status_changed',
        entityType: 'sim_card',
        entityId: id,
        actorUserId,
        actorRole,
        before: { status: before.status },
        after: { status: after.status },
      });
    }
    return after;
  }

  /**
   * Включение SIM партнёром.
   *
   * **Подтверждение оператора площадкой не требуется** (владелец, 2026-09-25: «зачем
   * оператора подтверждать площадкой?»). Прежнее правило исходило из допущения «у всех
   * партнёров безлимит только внутри своей сети», которое владелец отверг: куда звонить
   * карте, решает партнёр (TASKS 4.27). Карта включается с оператором по номеру.
   *
   * Источник всё же спрашивается один раз, если при заведении он промолчал: его ответ —
   * факт, а не допущение. Подтвердил того же оператора — отметка о подтверждении; подтвердил
   * **другого** — отказ с обоими названиями: карта заведена не тем оператором, и звонки
   * по нему ушли бы не туда. Молчит или недоступен (TASKS 4.21) — карта включается.
   */
  async activateOwnSim(
    id: SimCardId,
    partnerId: PartnerId,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<SimCardRow> {
    const sim = await this.requireOwnSim(id, partnerId);
    if (sim.status === 'blocked' || sim.status === 'retired') {
      throw conflict('SIM отключена площадкой — включить её может только администратор');
    }
    // Придерживает порог отказов или администратор — оба решение площадки. Включённая
    // партнёром карта, пока старые отказы ещё в окне, отключилась бы на следующем
    // проходе снова ([ADR-0047](../../../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md)).
    if (sim.status === 'throttled') {
      throw conflict('Карта придержана площадкой — включить её может только администратор', {
        details: { remedy: 'Проверьте карту и напишите площадке.' },
      });
    }
    if (sim.status === 'active') return sim;

    // Номер в базе заведомо канонический — его держит `sim_cards_msisdn_format`.
    const msisdn = parseMsisdn(sim.msisdn);
    await this.rejectHeldNumber(partnerId, msisdn);

    const resolution =
      sim.operatorConfirmedAt === null ? await this.resolver.resolve(msisdn) : undefined;
    if (resolution?.confirmed === true && resolution.serving !== undefined) {
      if (resolution.serving.id !== sim.operatorId) {
        const declared = await this.catalog.findOperator(sim.operatorId);
        // Оба названия в отказе: иначе партнёру нечего исправлять, кроме как гадать.
        throw validationFailed('Оператор SIM не совпадает с заявленным', {
          details: {
            declared: declared?.name ?? 'неизвестен',
            detected: resolution.serving.name,
            remedy: 'Заведите карту заново, указав верного оператора.',
          },
        });
      }
      await this.repository.confirmSimOperator(id, new Date());
    }

    // Условием на прежнее: пока шёл запрос к источнику, площадка могла придержать или
    // заблокировать карту, и безусловная запись затёрла бы её решение (ADR-0048).
    const updated = await this.repository.transitionSimStatus(id, sim.status, 'active');
    if (updated === undefined) return this.rejectStaleSim(id);

    await this.audit.record({
      action: 'sim.status_changed',
      entityType: 'sim_card',
      entityId: id,
      actorUserId,
      actorRole,
      before: { status: sim.status },
      after: { status: updated.status },
    });
    this.logger.info('SIM включена партнёром', {
      sim_card_id: id,
      operator_id: sim.operatorId,
      msisdn: maskMsisdn(sim.msisdn),
    });
    return updated;
  }

  /** Условие на прежнее состояние карты не совпало: карты нет — `404`, есть — её успели изменить. */
  private async rejectStaleSim(id: SimCardId): Promise<never> {
    const current = await this.repository.findSim(id);
    if (current === undefined) throw notFound('SIM не найдена');
    throw conflict('Состояние карты успело измениться — обновите страницу');
  }

  private toAccount(credentials: SipCredentials): IssuedSipAccount {
    return {
      username: credentials.username,
      password: credentials.password,
      realm: this.realm,
    };
  }
}

/**
 * Шлюз этого партнёра, которым он распоряжается сам: свой и не транк.
 *
 * Сужение типа, а не просто проверка: после неё обработчик работает со строкой,
 * а не с `undefined`.
 */
function isOwnPartnerGateway(
  gateway: GatewayRow | undefined,
  partnerId: PartnerId,
): gateway is GatewayRow {
  return gateway !== undefined && gateway.partnerId === partnerId && gateway.type !== 'sip_trunk';
}

/** Состояние шлюза для журнала: без источника `before`/`after` не отвечают, кто вправе вернуть. */
function stateForAudit(state: GatewayState): {
  status: GatewayStatus;
  suspended_by: GatewaySuspendedBy | null;
} {
  return { status: state.status, suspended_by: state.suspendedBy };
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

/**
 * Транк в журнале действий.
 *
 * Пароля провайдера здесь нет ни в каком виде — остаётся факт, что он задан. Журнал
 * читают через месяцы и не всегда те, кому этот пароль предназначен.
 */
function toTrunkAudit(trunk: SipTrunkRow): Record<string, unknown> {
  return {
    proxy_host: trunk.proxyHost,
    registers_outbound: trunk.registersOutbound,
    outbound_username: trunk.outboundUsername,
    has_secret: trunk.outboundSecret !== null,
    max_concurrent_calls: trunk.maxConcurrentCalls,
  };
}
