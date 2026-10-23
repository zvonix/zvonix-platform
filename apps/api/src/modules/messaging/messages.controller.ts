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
import type { MessageRefusalRow } from './refusals.repository.js';
import { MessagesService } from './messages.service.js';
import { MessagingService } from './messaging.service.js';
import { StopsService } from './stops.service.js';
import {
  journalQuerySchema,
  messagesOverviewQuerySchema,
  messagesQuerySchema,
  messagesReportQuerySchema,
  providerWebhookSchema,
  sendMessageSchema,
} from './schemas.js';

/** `validMinutes` запроса — срок сообщения от момента приёма (ADR-0097). */
const withValidity = ({
  validMinutes,
  ...rest
}: z.infer<typeof sendMessageSchema>): Parameters<MessagesService['send']>[1] => ({
  ...rest,
  ...(validMinutes === undefined
    ? {}
    : { validUntil: new Date(Date.now() + validMinutes * 60_000) }),
});

const withoutText = ({
  text: _text,
  full_text: _fullText,
  ...rest
}: ClientMessageView): Omit<ClientMessageView, 'text' | 'full_text'> => rest;

/** Сообщение так, как его видит клиент. */
interface ClientMessageView {
  readonly id: string;
  readonly external_id: string | null;
  readonly to: string;
  readonly text: string;
  readonly status: string;
  /** Наши причины, не слова провайдера. */
  readonly failure_reason: string | null;
  /** В конец сообщения добавлена строка про «СТОП». */
  readonly stop_line: boolean;
  /** Как сообщение получил человек (ADR-0093); `null` — не ушло или стёрто по сроку. */
  readonly full_text: string | null;
  /** Списано, ₽. Не отправлено — `null`: деньги возвращены. */
  readonly cost: string | null;
  readonly created_at: string;
  readonly sent_at: string | null;
  readonly delivered_at: string | null;
  readonly read_at: string | null;
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

type MessagesQuery = z.infer<typeof messagesQuerySchema>;
type JournalQuery = z.infer<typeof journalQuerySchema>;

/** Отбор журнала кабинета и включены ли отклонённые при приёме (ADR-0098). */
const journalOf = (query: JournalQuery) => {
  const onlyRefused = query.status === 'refused';
  const { status, ...rest } = query;
  return {
    period: periodOf({ ...rest, status: status === 'refused' ? undefined : status }),
    options: { refused: onlyRefused || query.refused !== undefined, onlyRefused },
  };
};

/** Отклонённое при приёме в журнале клиента: номер, когда, через что и почему; ни текста, ни денег (ADR-0098). */
interface ClientRefusedView extends Omit<ClientMessageView, 'status' | 'failure_reason'> {
  readonly kind: 'refused';
  readonly status: 'refused';
  readonly failure_reason: MessageRefusalRow['reason'];
  readonly channel: MessageRefusalRow['channel'];
}
type ClientJournalView = (ClientMessageView & { readonly kind: 'message' }) | ClientRefusedView;

interface StaffRefusedView extends Omit<ClientRefusedView, 'text' | 'full_text'> {
  readonly client_id: string;
  readonly route: null;
  readonly partner_id: null;
  readonly account_id: null;
  readonly attempts: 0;
  readonly money: { client: string; partner: string; margin: string };
}
type StaffJournalView = (StaffMessageView & { readonly kind: 'message' }) | StaffRefusedView;

const toClientRefusedView = (row: MessageRefusalRow): ClientRefusedView => ({
  id: row.id,
  kind: 'refused' as const,
  external_id: null,
  to: row.recipient,
  text: '',
  status: 'refused',
  failure_reason: row.reason,
  channel: row.channel,
  stop_line: false,
  full_text: null,
  cost: null,
  created_at: row.createdAt.toISOString(),
  sent_at: null,
  delivered_at: null,
  read_at: null,
});

/** То же для сотрудника: плюс клиент, деньги нулями. */
const toStaffRefusedView = (row: MessageRefusalRow): StaffRefusedView => {
  const { text: _text, full_text: _fullText, ...rest } = toClientRefusedView(row);
  return {
    ...rest,
    client_id: row.clientId,
    route: null,
    partner_id: null,
    account_id: null,
    attempts: 0,
    money: { client: '0', partner: '0', margin: '0' },
  };
};

/** Общая часть отбора журнала: состояние и период. Клиент и партнёр — только у сотрудников, свои — из сессии. */
const periodOf = (query: MessagesQuery) => ({
  ...(query.status === undefined ? {} : { status: query.status }),
  ...(query.from === undefined ? {} : { from: new Date(query.from) }),
  ...(query.to === undefined ? {} : { to: new Date(query.to) }),
  limit: query.limit,
  offset: query.offset,
});

/**
 * Сообщение в журнале партнёра: когда, каким аккаунтом, чем кончилось и сколько начислено. Ни получателя, ни текста, ни
 * клиента — это чужие данные (ADR-0014, персональные данные); партнёру хватает «ушло ли через мой аккаунт и что я получил».
 */
interface PartnerMessageView {
  readonly id: string;
  readonly account_id: string | null;
  readonly status: MessageRow['status'];
  readonly failure_reason: MessageRow['failureReason'];
  /** Начислено, ₽; не отправлено — `0`: начисление отменено вместе с возвратом клиенту. */
  readonly earned: string;
  readonly created_at: string;
  readonly sent_at: string | null;
  readonly delivered_at: string | null;
  readonly read_at: string | null;
}

const toPartnerView = (row: MessageRow): PartnerMessageView => ({
  id: row.id,
  account_id: row.accountId,
  status: row.status,
  failure_reason: row.failureReason,
  earned: row.status === 'failed' ? '0' : Money.format(row.partnerAmount),
  created_at: row.createdAt.toISOString(),
  sent_at: iso(row.sentAt),
  delivered_at: iso(row.deliveredAt),
  read_at: iso(row.readAt),
});

const toClientView = (row: MessageRow): ClientMessageView => ({
  id: row.id,
  external_id: row.externalId,
  to: row.recipient,
  text: row.text,
  status: row.status,
  failure_reason: row.failureReason,
  stop_line: row.stopLine,
  full_text: row.sentText,
  cost: row.status === 'failed' ? null : Money.format(row.clientAmount),
  created_at: row.createdAt.toISOString(),
  sent_at: iso(row.sentAt),
  delivered_at: iso(row.deliveredAt),
  read_at: iso(row.readAt),
});

/** То же для сотрудника плюс деньги по трём счетам и чей это аккаунт. */
interface StaffMessageView extends Omit<ClientMessageView, 'text' | 'full_text'> {
  readonly client_id: string;
  /** `bot` — сообщение ушло ботом; у него нет ни партнёра, ни аккаунта. */
  readonly route: 'account' | 'bot';
  readonly partner_id: string | null;
  readonly account_id: string | null;
  readonly attempts: number;
  readonly money: { client: string; partner: string; margin: string };
}

/** Текст сотруднику не отдаётся: разбору хватает получателя, статуса и денег, а текст — чужие персональные данные. */
const toStaffView = (row: MessageRow): StaffMessageView => ({
  ...withoutText(toClientView(row)),
  client_id: row.clientId,
  route: row.route,
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

  /** Бот или аккаунты у клиента: сколько людей перешли в бота и сколько сообщений каким путём (ADR-0094). */
  @Cabinets('client')
  @Get('client/messages/route-stats')
  async routeStats(
    @CurrentUser() actor: Principal,
    @Query(zodQuery(messagesReportQuerySchema)) query: z.infer<typeof messagesReportQuerySchema>,
  ) {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    return { days: query.days, ...(await this.messages.routeStatsOf(client.id, query.days)) };
  }

  /** Партнёры с ценой сообщения для клиента — из чего строится список приоритетов (ADR-0081). */
  @Cabinets('client')
  @Get('client/messages/offers')
  async offers(@CurrentUser() actor: Principal): Promise<{
    offers: { alias_id: string; display_name: string; min_price: string; max_price: string }[];
  }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    if (!(await this.messaging.isEnabled())) return { offers: [] };
    const rows = await this.messages.offers(client.id);
    return {
      offers: rows.map((row) => ({
        alias_id: row.aliasId,
        display_name: row.displayName,
        min_price: Money.format(row.min),
        max_price: Money.format(row.max),
      })),
    };
  }

  @Cabinets('client')
  @Get('client/messages')
  async list(
    @CurrentUser() actor: Principal,
    @Query(zodQuery(journalQuerySchema)) query: JournalQuery,
  ): Promise<{ messages: ClientJournalView[]; total: number }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const { period, options } = journalOf(query);
    const found = await this.messages.journal({ clientId: client.id, ...period }, options);
    return {
      total: found.total,
      messages: found.entries.map((entry) =>
        entry.kind === 'message'
          ? { ...toClientView(entry.row), kind: 'message' as const }
          : toClientRefusedView(entry.row),
      ),
    };
  }

  /** Отправка из кабинета. `201` — принято и поставлено в очередь, деньги списаны. */
  @Cabinets('client')
  @Post('client/messages')
  async send(
    @CurrentUser() actor: Principal,
    @Body(zodBody(sendMessageSchema)) body: z.infer<typeof sendMessageSchema>,
  ): Promise<{ message: ClientMessageView }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const row = await this.messages.send(client.id, withValidity(body));
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
    const row = await this.messages.send(clientOf(machine), withValidity(body));
    return { message: toClientView(row) };
  }

  @Machine('client_api')
  @Get('messages')
  async list(
    @CurrentMachine() machine: MachinePrincipal,
    @Query(zodQuery(messagesQuerySchema)) query: z.infer<typeof messagesQuerySchema>,
  ): Promise<{ messages: ClientMessageView[]; total: number }> {
    const found = await this.messages.list({ clientId: clientOf(machine), ...periodOf(query) });
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

  /** Отчёт: отказы и причины, доля прочитанных — по клиентам и по аккаунтам (ADR-0088). */
  @Roles('admin', 'support')
  @Get('messages/report')
  async report(
    @Query(zodQuery(messagesReportQuerySchema)) query: z.infer<typeof messagesReportQuerySchema>,
  ) {
    const report = await this.messages.report(query.days);
    return {
      days: query.days,
      clients: report.clients.map(({ clientId, ...rest }) => ({ client_id: clientId, ...rest })),
      // Бот или аккаунты по клиентам (ADR-0094).
      routes: report.routes.map((row) => ({
        client_id: row.clientId,
        name: row.name,
        recipients: row.recipients,
        in_bot: row.inBot,
        via_bot: row.viaBot,
        via_accounts: row.viaAccounts,
      })),
      accounts: report.accounts.map(({ accountId, partnerName, ...rest }) => ({
        account_id: accountId,
        partner_name: partnerName,
        ...rest,
      })),
      // Журнал аккаунтов (ADR-0088): проверки номеров и события состояния; для «блокировок на тысячу сообщений».
      journal: {
        sent_via_accounts: report.accounts.reduce((sum, row) => sum + row.sent, 0),
        blocked: report.journal.accounts.reduce((sum, row) => sum + row.blocked, 0),
        accounts: report.journal.accounts.map(
          ({
            accountId,
            partnerName,
            checks_exists,
            checks_absent,
            checks_unknown,
            checks_limited,
            ...rest
          }) => ({
            account_id: accountId,
            partner_name: partnerName,
            checks: {
              exists: checks_exists,
              absent: checks_absent,
              unknown: checks_unknown,
              limited: checks_limited,
            },
            ...rest,
          }),
        ),
        recent: report.journal.recent.map((event) => ({
          account_id: event.accountId,
          label: event.label,
          kind: event.kind,
          reason: event.reason,
          at: event.createdAt.toISOString(),
        })),
      },
    };
  }

  @Roles('admin', 'support')
  @Get('messages')
  async list(
    @Query(zodQuery(journalQuerySchema)) query: JournalQuery,
  ): Promise<{ messages: StaffJournalView[]; total: number }> {
    const { period, options } = journalOf(query);
    const found = await this.messages.journal(
      {
        ...period,
        ...(query.clientId === undefined ? {} : { clientId: parseId(query.clientId, 'client') }),
        ...(query.partnerId === undefined
          ? {}
          : { partnerId: parseId(query.partnerId, 'partner') }),
      },
      options,
    );
    return {
      total: found.total,
      messages: found.entries.map((entry) =>
        entry.kind === 'message'
          ? { ...toStaffView(entry.row), kind: 'message' as const }
          : toStaffRefusedView(entry.row),
      ),
    };
  }
}

/** Журнал партнёра: сообщения через его аккаунты и начисленное — как журнал вызовов с заработком (владелец, 2026-10-23). */
@Controller()
export class PartnerMessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly billing: BillingService,
  ) {}

  @Cabinets('partner')
  @Get('partner/messages/journal')
  async list(
    @CurrentUser() actor: Principal,
    @Query(zodQuery(messagesQuerySchema)) query: MessagesQuery,
  ): Promise<{ messages: PartnerMessageView[]; total: number }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const found = await this.messages.list({ partnerId: partner.id, ...periodOf(query) });
    return { total: found.total, messages: found.rows.map(toPartnerView) };
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
    private readonly stops: StopsService,
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
    } else if (body.typeWebhook === 'incomingMessageReceived') {
      await this.stops.handleIncoming(body, String(instance));
    }
    return {};
  }
}
