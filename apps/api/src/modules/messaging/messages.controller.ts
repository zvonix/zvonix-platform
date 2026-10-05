/**
 * Сообщения MAX: кабинет клиента, API клиента, сотрудники и приём статусов от провайдера
 * ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)).
 *
 * Правило приватности ADR-0014 то же, что у вызовов: клиент не видит партнёра и его долю, партнёр —
 * клиента. Провайдер не называется нигде.
 */

import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Money, notFound, parseId, permissionDenied, type Id } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets, Machine, Public, Roles } from '../../http/auth.guard.js';
import { CurrentMachine, CurrentUser } from '../../http/request-context.js';
import { zodBody, zodQuery } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import type { MessageRow } from './messages.repository.js';
import { MessagesService } from './messages.service.js';
import { MessagingService } from './messaging.service.js';
import {
  messagesOverviewQuerySchema,
  messagesQuerySchema,
  providerWebhookSchema,
  sendMessageSchema,
} from './schemas.js';

const withoutText = ({
  text: _text,
  ...rest
}: ClientMessageView): Omit<ClientMessageView, 'text'> => rest;

/** Сообщение так, как его видит клиент. */
interface ClientMessageView {
  readonly id: string;
  readonly external_id: string | null;
  readonly to: string;
  readonly text: string;
  readonly status: string;
  /** Наши причины, не слова провайдера. */
  readonly failure_reason: string | null;
  /** Списано, ₽. Не отправлено — `null`: деньги возвращены. */
  readonly cost: string | null;
  readonly created_at: string;
  readonly sent_at: string | null;
  readonly delivered_at: string | null;
  readonly read_at: string | null;
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

const toClientView = (row: MessageRow): ClientMessageView => ({
  id: row.id,
  external_id: row.externalId,
  to: row.recipient,
  text: row.text,
  status: row.status,
  failure_reason: row.failureReason,
  cost: row.status === 'failed' ? null : Money.format(row.clientAmount),
  created_at: row.createdAt.toISOString(),
  sent_at: iso(row.sentAt),
  delivered_at: iso(row.deliveredAt),
  read_at: iso(row.readAt),
});

/** То же для сотрудника плюс деньги по трём счетам и чей это аккаунт. */
interface StaffMessageView extends Omit<ClientMessageView, 'text'> {
  readonly client_id: string;
  readonly partner_id: string;
  readonly account_id: string;
  readonly attempts: number;
  readonly money: { client: string; partner: string; margin: string };
}

/** Текст сотруднику не отдаётся: разбору хватает получателя, статуса и денег, а текст — чужие персональные данные. */
const toStaffView = (row: MessageRow): StaffMessageView => ({
  ...withoutText(toClientView(row)),
  client_id: row.clientId,
  partner_id: row.partnerId,
  account_id: row.accountId,
  attempts: row.attempts,
  money: {
    client: Money.format(row.clientAmount),
    partner: Money.format(row.partnerAmount),
    margin: Money.format(row.commissionAmount),
  },
});

@Controller()
export class ClientMessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly messaging: MessagingService,
    private readonly billing: BillingService,
  ) {}

  /** Включён ли продукт и сколько стоит одно сообщение сейчас (`null` — принять некуда). */
  @Cabinets('client')
  @Get('client/messages/price')
  async price(
    @CurrentUser() actor: Principal,
  ): Promise<{ enabled: boolean; price: string | null }> {
    const enabled = await this.messaging.isEnabled();
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const quote = enabled ? await this.messages.quote(client.id) : undefined;
    return { enabled, price: quote === undefined ? null : Money.format(quote.clientAmount) };
  }

  @Cabinets('client')
  @Get('client/messages')
  async list(
    @CurrentUser() actor: Principal,
    @Query(zodQuery(messagesQuerySchema)) query: z.infer<typeof messagesQuerySchema>,
  ): Promise<{ messages: ClientMessageView[]; total: number }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const found = await this.messages.list({
      clientId: client.id,
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit,
      offset: query.offset,
    });
    return { total: found.total, messages: found.rows.map(toClientView) };
  }

  /** Отправка из кабинета. `201` — принято и поставлено в очередь, деньги списаны. */
  @Cabinets('client')
  @Post('client/messages')
  async send(
    @CurrentUser() actor: Principal,
    @Body(zodBody(sendMessageSchema)) body: z.infer<typeof sendMessageSchema>,
  ): Promise<{ message: ClientMessageView }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const row = await this.messages.send(client.id, body);
    return { message: toClientView(row) };
  }
}

/** Контур API клиента по ключу ([ADR-0044](../../../../../docs/adr/0044-klientskiy-api.md)): `/v1/messages`. */
@Controller('v1')
export class ClientApiMessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Machine('client_api')
  @Post('messages')
  async send(
    @CurrentMachine() machine: MachinePrincipal,
    @Body(zodBody(sendMessageSchema)) body: z.infer<typeof sendMessageSchema>,
  ): Promise<{ message: ClientMessageView }> {
    const row = await this.messages.send(clientOf(machine), body);
    return { message: toClientView(row) };
  }

  @Machine('client_api')
  @Get('messages')
  async list(
    @CurrentMachine() machine: MachinePrincipal,
    @Query(zodQuery(messagesQuerySchema)) query: z.infer<typeof messagesQuerySchema>,
  ): Promise<{ messages: ClientMessageView[]; total: number }> {
    const found = await this.messages.list({
      clientId: clientOf(machine),
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit,
      offset: query.offset,
    });
    return { total: found.total, messages: found.rows.map(toClientView) };
  }

  @Machine('client_api')
  @Get('messages/:id')
  async get(
    @CurrentMachine() machine: MachinePrincipal,
    @Param('id') id: string,
  ): Promise<{ message: ClientMessageView }> {
    const row = await this.messages.get(clientOf(machine), id);
    if (row === undefined) throw notFound('Сообщение не найдено');
    return { message: toClientView(row) };
  }
}

const clientOf = (machine: MachinePrincipal): Id<'client'> => parseId(machine.ownerId, 'client');

/** Сотрудникам: все сообщения с деньгами по трём счетам. */
@Controller()
export class StaffMessagesController {
  constructor(private readonly messages: MessagesService) {}

  /** Показатели по суткам для «Обзора»: принято, доставлено, не отправлено, деньги без возвращённых. */
  @Roles('admin', 'support')
  @Get('messages/overview')
  async overview(
    @Query(zodQuery(messagesOverviewQuerySchema))
    query: z.infer<typeof messagesOverviewQuerySchema>,
  ) {
    const series = await this.messages.overview(query.days, query.offset);
    return {
      days: query.days,
      series: series.map((row) => ({
        day: row.day,
        messages: row.messages,
        delivered: row.delivered,
        failed: row.failed,
        revenue: Money.format(row.revenue),
        margin: Money.format(row.margin),
      })),
    };
  }

  @Roles('admin', 'support')
  @Get('messages')
  async list(
    @Query(zodQuery(messagesQuerySchema)) query: z.infer<typeof messagesQuerySchema>,
  ): Promise<{ messages: StaffMessageView[]; total: number }> {
    const found = await this.messages.list({
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit,
      offset: query.offset,
    });
    return { total: found.total, messages: found.rows.map(toStaffView) };
  }
}

/**
 * Приём статусов доставки от провайдера. Открыт без входа, но путь содержит секрет, выведенный из
 * `SECRET_KEY`: без него адрес не подобрать. Всегда `200` на уведомление, которое нас не касается:
 * повторы провайдера нам не нужны.
 */
@Controller()
export class MessengerWebhookController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly messages: MessagesService,
  ) {}

  @Public()
  @Post('webhooks/messenger/:secret')
  @HttpCode(200)
  async receive(
    @Param('secret') secret: string,
    @Body(zodBody(providerWebhookSchema)) body: z.infer<typeof providerWebhookSchema>,
  ): Promise<Record<string, never>> {
    const expected = Buffer.from(this.messaging.webhookSecret());
    const given = Buffer.from(secret);
    // Сравнение за постоянное время; чужому адресу — тот же отказ, что и несуществующему.
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw permissionDenied('Недостаточно прав');
    }

    const instance = body.instanceData?.idInstance;
    if (instance === undefined) return {};

    if (body.typeWebhook === 'outgoingMessageStatus') {
      if (body.idMessage !== undefined && body.status !== undefined) {
        await this.messages.applyDeliveryStatus(String(instance), body.idMessage, body.status);
      }
    } else if (body.typeWebhook === 'stateInstanceChanged') {
      await this.messaging.refreshByInstance(String(instance));
    }
    return {};
  }
}
