/**
 * Обращения в поддержку ([ADR-0085](../../../../../docs/adr/0085-obrashcheniya-v-podderzhku.md)).
 *
 * Автор (клиент или партнёр) работает с `/support/tickets`: идентификатор владельца берётся из сессии. Сотрудники —
 * с `/support/staff/tickets`.
 */

import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { TicketStatus } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets, Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody, zodQuery } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import {
  createTicketSchema,
  staffMessageSchema,
  ticketAssigneeSchema,
  ticketMessageSchema,
  ticketStatusSchema,
  ticketsQuerySchema,
} from './schemas.js';
import type { TicketMessageRow, TicketRow } from './support.repository.js';
import { SupportService, type SupportActor, type TicketDetail } from './support.service.js';

interface TicketJson {
  readonly id: string;
  readonly subject: string;
  readonly category: string;
  readonly status: TicketStatus;
  readonly cabinet: string;
  readonly author_email: string;
  readonly assignee_user_id: string | null;
  readonly last_message_at: string;
  /** Поддержка ответила, автор ещё не открывал (ADR-0089). */
  readonly unread: boolean;
  readonly created_at: string;
}

interface MessageJson {
  readonly id: string;
  readonly side: string;
  readonly body: string;
  readonly internal: boolean;
  readonly created_at: string;
}

const ticketJson = (row: TicketRow): TicketJson => ({
  id: row.id,
  subject: row.subject,
  category: row.category,
  status: row.status,
  cabinet: row.cabinet,
  author_email: row.authorEmail,
  assignee_user_id: row.assigneeUserId,
  last_message_at: row.lastMessageAt.toISOString(),
  unread:
    row.status === 'waiting_user' &&
    (row.authorReadAt === null || row.authorReadAt < row.lastMessageAt),
  created_at: row.createdAt.toISOString(),
});

const messageJson = (row: TicketMessageRow): MessageJson => ({
  id: row.id,
  side: row.side,
  body: row.body,
  internal: row.internal,
  created_at: row.createdAt.toISOString(),
});

const detailJson = (detail: TicketDetail) => ({
  ticket: ticketJson(detail.ticket),
  messages: detail.messages.map(messageJson),
});

const actorOf = (principal: Principal): SupportActor => ({
  userId: principal.userId,
  role: principal.role,
  email: principal.email,
});

@Controller()
export class SupportController {
  constructor(private readonly support: SupportService) {}

  // --- автор: клиент или партнёр ---

  @Cabinets('client', 'partner')
  @Get('support/tickets')
  async listOwn(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(ticketsQuerySchema)) query: z.infer<typeof ticketsQuerySchema>,
  ) {
    const found = await this.support.listOwn(actorOf(principal), {
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit,
      offset: query.offset,
    });
    return { tickets: found.rows.map(ticketJson), total: found.total };
  }

  @Cabinets('client', 'partner')
  @Post('support/tickets')
  async create(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createTicketSchema)) body: z.infer<typeof createTicketSchema>,
  ) {
    return detailJson(await this.support.create(actorOf(principal), body));
  }

  /** Сколько обращений ждут прочтения автором — для числа у пункта «Поддержка». До маршрута с `:id`, иначе путь съест он. */
  @Cabinets('client', 'partner')
  @Get('support/tickets/unread')
  async unread(@CurrentUser() principal: Principal): Promise<{ total: number }> {
    return { total: await this.support.unreadOwn(actorOf(principal)) };
  }

  @Cabinets('client', 'partner')
  @Get('support/tickets/:id')
  async getOwn(@CurrentUser() principal: Principal, @Param('id') id: string) {
    return detailJson(await this.support.getOwn(actorOf(principal), id));
  }

  @Cabinets('client', 'partner')
  @Post('support/tickets/:id/messages')
  async reply(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodBody(ticketMessageSchema)) body: z.infer<typeof ticketMessageSchema>,
  ) {
    return detailJson(await this.support.reply(actorOf(principal), id, body.body));
  }

  @Cabinets('client', 'partner')
  @HttpCode(200)
  @Post('support/tickets/:id/close')
  async close(@CurrentUser() principal: Principal, @Param('id') id: string) {
    return detailJson(await this.support.close(actorOf(principal), id));
  }

  // --- сотрудники ---

  @Roles('admin', 'support')
  @Get('support/staff/tickets')
  async listStaff(@Query(zodQuery(ticketsQuerySchema)) query: z.infer<typeof ticketsQuerySchema>) {
    const found = await this.support.listStaff({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.cabinet === undefined ? {} : { cabinet: query.cabinet }),
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.unassigned === undefined ? {} : { unassigned: true }),
      ...(query.q === undefined ? {} : { search: query.q }),
      limit: query.limit,
      offset: query.offset,
    });
    return { tickets: found.rows.map(ticketJson), total: found.total };
  }

  @Roles('admin', 'support')
  @Get('support/staff/tickets/:id')
  async getStaff(@Param('id') id: string) {
    return detailJson(await this.support.getStaff(id));
  }

  @Roles('admin', 'support')
  @Post('support/staff/tickets/:id/messages')
  async staffReply(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodBody(staffMessageSchema)) body: z.infer<typeof staffMessageSchema>,
  ) {
    return detailJson(await this.support.staffReply(actorOf(principal), id, body));
  }

  @Roles('admin', 'support')
  @Patch('support/staff/tickets/:id/status')
  async setStatus(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodBody(ticketStatusSchema)) body: z.infer<typeof ticketStatusSchema>,
  ) {
    return detailJson(await this.support.setStatus(actorOf(principal), id, body.status));
  }

  @Roles('admin', 'support')
  @Patch('support/staff/tickets/:id/assignee')
  async assign(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodBody(ticketAssigneeSchema)) body: z.infer<typeof ticketAssigneeSchema>,
  ) {
    return detailJson(await this.support.assign(actorOf(principal), id, body.assignee === 'me'));
  }
}
