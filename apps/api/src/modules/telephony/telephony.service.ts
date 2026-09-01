/**
 * Учётные записи SIP обеих сторон вызова (ADR-0009).
 *
 * Каталог отдаётся из control plane, а не лежит файлом на узле. Смысл ровно один:
 * заблокировали партнёра — его шлюз перестал регистрироваться при следующей же попытке,
 * без раскатки конфигурации и без перезапуска узла.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  notFound,
  type ChannelStatus,
  type GatewayStatus,
  type GatewayType,
  type Id,
  type UserRole,
} from '@zvonix/shared';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { directoryDocument, notFoundDocument, type DirectoryUser } from './directory-xml.js';
import { issueSipCredentials, type SipCredentials } from './sip-credentials.js';
import {
  TelephonyRepository,
  type ChannelId,
  type ChannelRow,
  type GatewayId,
  type GatewayRow,
} from './telephony.repository.js';

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
    private readonly audit: AuditService,
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
