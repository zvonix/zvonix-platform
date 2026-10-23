/**
 * Подключение клиента по SMPP: кабинет клиента
 * ([ADR-0072](../../../../../../docs/adr/0072-smpp-dlya-soobscheniy.md)).
 *
 * Пароль отдаётся один раз — в ответе на создание и на смену. Дальше он нигде не читается.
 */

import { isIP } from 'node:net';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';
import { notFound, parseId, validationFailed, type Id, type SmppReceiptMap } from '@zvonix/shared';
import { Cabinets, Roles } from '../../../http/auth.guard.js';
import { CurrentUser } from '../../../http/request-context.js';
import { zodBody } from '../../../http/zod.pipe.js';
import { APP_CONFIG, type Config } from '../../../infra/tokens.js';
import { BillingService } from '../../billing/billing.service.js';
import type { Principal } from '../../identity/identity.service.js';
import { MessagingService } from '../messaging.service.js';
import { updateSmppSchema, staffSmppSchema } from '../schemas.js';
import { SmppServer } from './server.js';
import type { SmppAccountRow } from './smpp.repository.js';
import { receiptsOf, SmppService, type SmppEventView } from './smpp.service.js';

interface SmppView {
  readonly system_id: string;
  readonly enabled: boolean;
  readonly allowed_ips: readonly string[];
  readonly receipts: SmppReceiptMap;
  readonly last_bind_at: string | null;
  readonly created_at: string;
}

interface ConnectionView {
  readonly host: string;
  readonly port: number | null;
  readonly tls_port: number | null;
}

/** Кто сейчас на связи под подключением клиента: адрес, режим, с какого времени. Пусто — никто. */
interface OnlineView {
  readonly ip: string;
  readonly mode: string;
  readonly since: string;
}

const onlineOf = (server: SmppServer, clientId: Id<'client'>): OnlineView[] =>
  server.sessionsOf(clientId).map((session) => ({
    ip: session.ip,
    mode: session.mode,
    since: session.since.toISOString(),
  }));

const toView = (row: SmppAccountRow): SmppView => ({
  system_id: row.systemId,
  enabled: row.enabled,
  allowed_ips: row.allowedIps,
  receipts: receiptsOf(row),
  last_bind_at: row.lastBindAt?.toISOString() ?? null,
  created_at: row.createdAt.toISOString(),
});

@Controller()
export class ClientSmppController {
  constructor(
    private readonly smpp: SmppService,
    private readonly messaging: MessagingService,
    private readonly billing: BillingService,
    private readonly server: SmppServer,
    @Inject(APP_CONFIG) private readonly config: Config,
  ) {}

  /** Куда подключаться: адрес кабинета и порты слушателя; `null` у порта — этот способ не включён. */
  private connection(): ConnectionView {
    return {
      host: new URL(this.config.PUBLIC_BASE_URL).hostname,
      port: this.config.SMPP_PORT > 0 ? this.config.SMPP_PORT : null,
      tls_port: this.config.SMPP_TLS_PORT > 0 ? this.config.SMPP_TLS_PORT : null,
    };
  }

  @Cabinets('client')
  @Get('client/messages/smpp')
  async get(@CurrentUser() actor: Principal): Promise<{
    enabled: boolean;
    connection: ConnectionView;
    smpp: (SmppView & { online: OnlineView[] }) | null;
  }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const account = await this.smpp.find(client.id);
    return {
      enabled: await this.messaging.isEnabled(),
      connection: this.connection(),
      smpp:
        account === undefined
          ? null
          : { ...toView(account), online: onlineOf(this.server, client.id) },
    };
  }

  /** Создаёт подключение. `201` — пароль в ответе единственный раз. */
  @Cabinets('client')
  @Post('client/messages/smpp')
  async create(@CurrentUser() actor: Principal): Promise<{ smpp: SmppView; password: string }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const { account, password } = await this.smpp.create(actor, client.id);
    return { smpp: toView(account), password };
  }

  /** Новый пароль: прежний сразу перестаёт подходить для новых подключений. */
  @Cabinets('client')
  @Post('client/messages/smpp/password')
  async resetPassword(
    @CurrentUser() actor: Principal,
  ): Promise<{ smpp: SmppView; password: string }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const { account, password } = await this.smpp.resetPassword(actor, client.id);
    return { smpp: toView(account), password };
  }

  /** Журнал подключения: входы и отказы в приёме, новые сверху (ADR-0096). */
  @Cabinets('client')
  @Get('client/messages/smpp/events')
  async events(@CurrentUser() actor: Principal): Promise<{ events: SmppEventView[] }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    return { events: await this.smpp.eventsOf(client.id) };
  }

  @Cabinets('client')
  @Patch('client/messages/smpp')
  async update(
    @CurrentUser() actor: Principal,
    @Body(zodBody(updateSmppSchema)) body: z.infer<typeof updateSmppSchema>,
  ): Promise<{ smpp: SmppView }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const account = await this.smpp.update(actor, client.id, body);
    return { smpp: toView(account) };
  }
}

/** Подключения SMPP всех клиентов — сотрудникам; отключить или вернуть может администратор. */
@Controller()
export class StaffSmppController {
  constructor(
    private readonly smpp: SmppService,
    private readonly billing: BillingService,
    private readonly server: SmppServer,
  ) {}

  @Roles('admin', 'support')
  @Get('smpp/accounts')
  async list(): Promise<{
    accounts: (SmppView & {
      client_id: string;
      client_name: string | null;
      online: OnlineView[];
    })[];
  }> {
    const { rows } = await this.billing.listClients({ limit: 200, offset: 0 });
    const names = new Map<string, string>(rows.map((client) => [client.id, client.name]));
    const accounts = await this.smpp.list();
    return {
      accounts: accounts.map((row) => ({
        ...toView(row),
        client_id: row.clientId,
        client_name: names.get(row.clientId) ?? null,
        online: onlineOf(this.server, row.clientId),
      })),
    };
  }

  /** Журнал подключения клиента — сотрудникам: подключается ли программа и почему отклонена (ADR-0096). */
  @Roles('admin', 'support')
  @Get('smpp/accounts/:clientId/events')
  async events(@Param('clientId') clientId: string): Promise<{ events: SmppEventView[] }> {
    return { events: await this.smpp.eventsOf(parseId(clientId, 'client')) };
  }

  /** Журнал площадки: все подключения и входы с неизвестным именем (ADR-0096, дополнение 2026-10-23). */
  @Roles('admin', 'support')
  @Get('smpp/events')
  async platformEvents() {
    return { events: await this.smpp.platformEvents() };
  }

  /** Адреса на паузе за подбор пароля прямо сейчас. */
  @Roles('admin', 'support')
  @Get('smpp/blocked')
  blocked() {
    return {
      blocked: this.server.blockedAddresses().map((row) => ({
        ip: row.ip,
        failures: row.failures,
        until: row.until.toISOString(),
      })),
    };
  }

  /** Снять паузу раньше срока — например, клиент исправил пароль и не хочет ждать. */
  @Roles('admin')
  @Delete('smpp/blocked/:ip')
  async release(
    @CurrentUser() actor: Principal,
    @Param('ip') ip: string,
  ): Promise<{ released: true }> {
    if (isIP(ip) === 0) throw validationFailed('Это не адрес IP');
    if (!this.server.release(ip)) throw notFound('Этот адрес не на паузе');
    await this.smpp.auditRelease(actor, ip);
    return { released: true };
  }

  /** Отключение или возврат подключения клиента: пароль и адреса не трогаются. */
  @Roles('admin')
  @Patch('smpp/accounts/:clientId')
  async update(
    @CurrentUser() actor: Principal,
    @Param('clientId') clientId: string,
    @Body(zodBody(staffSmppSchema)) body: z.infer<typeof staffSmppSchema>,
  ): Promise<{ smpp: SmppView }> {
    const account = await this.smpp.update(actor, parseId(clientId, 'client'), {
      enabled: body.enabled,
    });
    return { smpp: toView(account) };
  }
}
