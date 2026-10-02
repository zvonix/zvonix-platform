/**
 * Заявки на пополнение счёта
 * ([ADR-0064](../../../../../docs/adr/0064-platezhi-karkas.md)).
 *
 * Клиент создаёт и отзывает свои заявки; сотрудники их видят; решает — **только администратор**:
 * подтверждение кладёт деньги на счёт, и поддержке такого права нет, как нет его и у
 * ручного пополнения (`POST /clients/:id/deposit`).
 */

import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Money, parseId, type PaymentStatus } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets, Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody, zodQuery } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import type { PaymentRow } from './payments.repository.js';
import { PaymentsService } from './payments.service.js';
import {
  confirmPaymentSchema,
  createPaymentSchema,
  paymentsQuerySchema,
  rejectPaymentSchema,
} from './schemas.js';

interface PaymentView {
  readonly id: string;
  readonly client_id: string;
  readonly status: PaymentStatus;
  readonly amount: string;
  readonly received_amount: string | null;
  readonly comment: string | null;
  readonly resolution_note: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

function toView(row: PaymentRow): PaymentView {
  return {
    id: row.id,
    client_id: row.clientId,
    status: row.status,
    amount: Money.format(row.amount),
    received_amount: row.receivedAmount === null ? null : Money.format(row.receivedAmount),
    comment: row.comment,
    resolution_note: row.resolutionNote,
    created_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt?.toISOString() ?? null,
  };
}

@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly billing: BillingService,
  ) {}

  /** Заявки клиента и реквизиты для перевода (пусто — приём заявок закрыт). */
  @Cabinets('client')
  @Get('client/payments')
  async listOwn(@CurrentUser() actor: Principal): Promise<{
    instructions: string;
    payments: PaymentView[];
  }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const found = await this.payments.list({ clientId: client.id, limit: 50, offset: 0 });
    return {
      instructions: await this.payments.instructions(),
      payments: found.rows.map(toView),
    };
  }

  @Cabinets('client')
  @Post('client/payments')
  async create(
    @CurrentUser() actor: Principal,
    @Body(zodBody(createPaymentSchema)) body: z.infer<typeof createPaymentSchema>,
  ): Promise<{ payment: PaymentView; instructions: string }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const payment = await this.payments.create(client.id, parseId(actor.userId, 'user'), {
      amount: body.amount,
      comment: body.comment,
    });
    return { payment: toView(payment), instructions: await this.payments.instructions() };
  }

  @Cabinets('client')
  @Post('client/payments/:id/cancel')
  @HttpCode(200)
  async cancel(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ payment: PaymentView }> {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const payment = await this.payments.cancelOwn(
      parseId(id, 'payment'),
      client.id,
      parseId(actor.userId, 'user'),
    );
    return { payment: toView(payment) };
  }

  @Roles('admin', 'support')
  @Get('payments')
  async list(
    @Query(zodQuery(paymentsQuerySchema)) query: z.infer<typeof paymentsQuerySchema>,
  ): Promise<{ payments: PaymentView[]; total: number }> {
    const found = await this.payments.list({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.clientId === undefined ? {} : { clientId: parseId(query.clientId, 'client') }),
      limit: query.limit,
      offset: query.offset,
    });
    return { total: found.total, payments: found.rows.map(toView) };
  }

  @Roles('admin')
  @Post('payments/:id/confirm')
  @HttpCode(200)
  async confirm(
    @Param('id') id: string,
    @Body(zodBody(confirmPaymentSchema)) body: z.infer<typeof confirmPaymentSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ payment: PaymentView }> {
    const payment = await this.payments.confirm(
      parseId(id, 'payment'),
      { userId: parseId(actor.userId, 'user'), role: actor.role },
      body.amount,
    );
    return { payment: toView(payment) };
  }

  @Roles('admin')
  @Post('payments/:id/reject')
  @HttpCode(200)
  async reject(
    @Param('id') id: string,
    @Body(zodBody(rejectPaymentSchema)) body: z.infer<typeof rejectPaymentSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ payment: PaymentView }> {
    const payment = await this.payments.reject(
      parseId(id, 'payment'),
      { userId: parseId(actor.userId, 'user'), role: actor.role },
      body.reason,
    );
    return { payment: toView(payment) };
  }
}
