/**
 * Линии и вызовы так, как их видит **сам клиент**.
 *
 * Клиент выводится из сессии, а не принимается параметром: административные обработчики
 * начинаются с идентификатора клиента в адресе, и открыть их роли `client` значило бы
 * разрешить подставить чужой.
 *
 * До появления этих обработчиков клиент не мог перечислить собственные каналы. При этом
 * настраивать их — порядок партнёров и разрешённые операторы — ему было разрешено:
 * то есть право существовало, а воспользоваться им было нечем.
 */

import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Money, OWN_CHANNELS_MAX, parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody, zodQuery } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import { CallsService } from './calls.service.js';
import {
  toClientCallView,
  toClientChannelView,
  type ClientCallView,
  type ClientChannelView,
} from './client-views.js';
import {
  clientCallsQuerySchema,
  createOwnChannelSchema,
  ownChannelStatusSchema,
  updateOwnChannelSchema,
} from './schemas.js';
import { TelephonyService } from './telephony.service.js';

interface OwnSipAccount {
  readonly username: string;
  readonly password: string;
  readonly realm: string;
  /** Куда подключаться — адрес узла, а не домен (`TelephonyService.sipServer`). */
  readonly server: string;
}

function toOwnAccount(account: Omit<OwnSipAccount, 'server'>, server: string): OwnSipAccount {
  return { username: account.username, password: account.password, realm: account.realm, server };
}

@Controller()
export class ClientReportController {
  constructor(
    private readonly telephony: TelephonyService,
    private readonly calls: CallsService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Свои линии.
   *
   * По их идентификаторам клиент настраивает порядок партнёров и разрешённых
   * операторов — обработчики те же, что и у администратора, владение проверяет служба.
   */
  @Cabinets('client')
  @Get('client/channels')
  async channels(@CurrentUser() actor: Principal): Promise<{
    channels: ClientChannelView[];
    /** Куда подключать программу: адрес узла, а не SIP-домен (`TelephonyService.sipServer`). */
    server: string;
    /** Сколько линий можно держать; удалённые не в счёт (ADR-0101). */
    max_channels: number;
  }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const rows = await this.telephony.listOpenChannels(client.id);
    const now = new Date();
    const activity = await this.calls.channelActivity(
      rows.map((row) => row.id),
      now,
    );
    return {
      channels: rows.map((row) => toClientChannelView(row, now, activity.get(row.id))),
      server: await this.telephony.sipServer(),
      max_channels: OWN_CHANNELS_MAX,
    };
  }

  /** Правка своей линии: название, комментарий, предел одновременных (ADR-0101). Чужая — `404`. */
  @Cabinets('client')
  @Patch('client/channels/:id')
  async updateChannel(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(updateOwnChannelSchema)) body: z.infer<typeof updateOwnChannelSchema>,
  ): Promise<{ channel: ClientChannelView }> {
    // Поштучно, а не разворотом: при `exactOptionalPropertyTypes` «поля нет» и «undefined» — разное.
    const updated = await this.telephony.updateOwnChannel(
      parseId(id, 'channel'),
      {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.comment === undefined ? {} : { comment: body.comment }),
        ...(body.maxConcurrentCalls === undefined
          ? {}
          : { maxConcurrentCalls: body.maxConcurrentCalls }),
      },
      actor,
    );
    return { channel: toClientChannelView(updated, new Date()) };
  }

  /**
   * Включить, выключить или удалить свою линию (ADR-0101, п. 4). Выключенную площадкой — `409`
   * `channel_platform_managed`, удалённую — `409` `channel_closed`.
   */
  @Cabinets('client')
  @Post('client/channels/:id/status')
  async setChannelStatus(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(ownChannelStatusSchema)) body: z.infer<typeof ownChannelStatusSchema>,
  ): Promise<{ channel: ClientChannelView }> {
    const updated = await this.telephony.setOwnChannelStatus(
      parseId(id, 'channel'),
      body.status,
      actor,
    );
    return { channel: toClientChannelView(updated, new Date()) };
  }

  /**
   * Завести себе линию ([ADR-0058](../../../../../docs/adr/0058-klient-sam-poluchaet-liniyu.md)).
   * Пароль SIP в ответе — единственный показ.
   */
  @Cabinets('client')
  @Post('client/channels')
  async createChannel(
    @CurrentUser() actor: Principal,
    @Body(zodBody(createOwnChannelSchema)) body: z.infer<typeof createOwnChannelSchema>,
  ): Promise<{ channel: ClientChannelView; account: OwnSipAccount }> {
    const created = await this.telephony.createOwnChannel(actor, body.name);
    return {
      channel: toClientChannelView(created.channel, new Date()),
      account: toOwnAccount(created.account, await this.telephony.sipServer()),
    };
  }

  /** Новый доступ своей линии: прежний перестаёт работать. */
  @Cabinets('client')
  @Post('client/channels/:id/credentials')
  async resetCredentials(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
  ): Promise<{ account: OwnSipAccount }> {
    const account = await this.telephony.resetOwnChannelCredentials(parseId(id, 'channel'), actor);
    return { account: toOwnAccount(account, await this.telephony.sipServer()) };
  }

  /**
   * Свои вызовы — «за что списали» и «почему не звонит» со стороны клиента.
   *
   * Отбор уже административного (`clientCallsQuerySchema`): клиент подставляется
   * из сессии, партнёров клиенту не различить, а причина отказа в его ответах —
   * переведённая. Чужой канал в отборе отсеивать не нужно: рядом стоит отбор
   * по клиенту, и чужой канал просто не даст ни одной строки.
   */
  @Cabinets('client')
  @Get('client/calls')
  async listCalls(
    @CurrentUser() actor: Principal,
    @Query(zodQuery(clientCallsQuerySchema)) query: z.infer<typeof clientCallsQuerySchema>,
  ): Promise<{ calls: (ClientCallView & { cost: string | null })[]; total: number }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);

    const found = await this.calls.list({
      clientId: client.id,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.channelId === undefined ? {} : { channelId: parseId(query.channelId, 'channel') }),
      ...(query.destination === undefined ? {} : { destination: query.destination }),
      ...(query.from === undefined ? {} : { from: new Date(query.from) }),
      ...(query.to === undefined ? {} : { to: new Date(query.to) }),
      limit: query.limit,
      offset: query.offset,
    });

    // Стоимость — из проводок вызова одним запросом на страницу; нет проводки — стоимость пуста.
    const charged = await this.billing.chargesForCalls(found.rows.map((row) => row.call.id));
    return {
      total: found.total,
      calls: found.rows.map((row) => {
        const cost = charged.get(row.call.id)?.client;
        return { ...toClientCallView(row), cost: cost === undefined ? null : Money.format(cost) };
      }),
    };
  }
}
