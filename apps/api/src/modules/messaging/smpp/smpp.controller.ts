/**
 * Подключение клиента по SMPP: кабинет клиента
 * ([ADR-0072](../../../../../../docs/adr/0072-smpp-dlya-soobscheniy.md)).
 *
 * Пароль отдаётся один раз — в ответе на создание и на смену. Дальше он нигде не читается.
 */

import { Body, Controller, Get, Inject, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';
import { Cabinets } from '../../../http/auth.guard.js';
import { CurrentUser } from '../../../http/request-context.js';
import { zodBody } from '../../../http/zod.pipe.js';
import { APP_CONFIG, type Config } from '../../../infra/tokens.js';
import { BillingService } from '../../billing/billing.service.js';
import type { Principal } from '../../identity/identity.service.js';
import { MessagingService } from '../messaging.service.js';
import { updateSmppSchema } from '../schemas.js';
import type { SmppAccountRow } from './smpp.repository.js';
import { SmppService } from './smpp.service.js';

interface SmppView {
  readonly system_id: string;
  readonly enabled: boolean;
  readonly allowed_ips: readonly string[];
  readonly last_bind_at: string | null;
  readonly created_at: string;
}

interface ConnectionView {
  readonly host: string;
  readonly port: number | null;
  readonly tls_port: number | null;
}

const toView = (row: SmppAccountRow): SmppView => ({
  system_id: row.systemId,
  enabled: row.enabled,
  allowed_ips: row.allowedIps,
  last_bind_at: row.lastBindAt?.toISOString() ?? null,
  created_at: row.createdAt.toISOString(),
});

@Controller()
export class ClientSmppController {
  constructor(
    private readonly smpp: SmppService,
    private readonly messaging: MessagingService,
    private readonly billing: BillingService,
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
  async get(
    @CurrentUser() actor: Principal,
  ): Promise<{ enabled: boolean; connection: ConnectionView; smpp: SmppView | null }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const account = await this.smpp.find(client.id);
    return {
      enabled: await this.messaging.isEnabled(),
      connection: this.connection(),
      smpp: account === undefined ? null : toView(account),
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
