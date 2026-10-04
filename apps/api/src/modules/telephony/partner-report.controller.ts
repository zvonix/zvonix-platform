/**
 * Обращения партнёра: человеческая часть (ADR-0013).
 */

import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Money, parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets, Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodQuery } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import type { CallRow } from './call.repository.js';
import { PartnerReportService } from './partner-report.service.js';
import { partnerCallsQuerySchema } from './schemas.js';

/**
 * Вызов так, как его видит партнёр.
 *
 * Ни канала, ни клиента: партнёр знает только, что через его железо прошёл вызов
 * на такой-то номер. Кто заказал вызов — не его дело, и обратная сторона
 * [ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md) работает так же:
 * стороны не видят друг друга.
 */
interface PartnerCallView {
  readonly id: string;
  readonly destination: string;
  readonly status: string;
  readonly sim_card_id: string | null;
  readonly gateway_id: string | null;
  readonly operator_id: string | null;
  readonly duration_seconds: number | null;
  readonly started_at: string;
}

@Controller()
export class PartnerReportController {
  constructor(
    private readonly reports: PartnerReportService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Вызовы партнёра страницами: по ним он сверяется со счётом своего оператора.
   *
   * Партнёру — только свои, независимо от `partnerId`; администратору и поддержке —
   * названного партнёра. `total` — число всех подходящих, а не размер страницы: без него
   * «здесь нет — значит, шёл не через площадку» было бы неправдой за первой страницей.
   */
  @Roles('admin', 'support')
  @Cabinets('partner')
  @Get('partner/calls')
  async listCalls(
    @CurrentUser() actor: Principal,
    @Query(zodQuery(partnerCallsQuerySchema)) query: z.infer<typeof partnerCallsQuerySchema>,
  ): Promise<{ calls: (PartnerCallView & { earned: string | null })[]; total: number }> {
    const found = await this.reports.listCalls(
      { userId: actor.userId, role: actor.role },
      {
        ...(query.partnerId === undefined
          ? {}
          : { partnerId: parseId(query.partnerId, 'partner') }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.from === undefined ? {} : { from: new Date(query.from) }),
        ...(query.to === undefined ? {} : { to: new Date(query.to) }),
        limit: query.limit,
        offset: query.offset,
      },
    );
    // Заработок по вызову — из его проводки (долю партнёра), одним запросом на страницу.
    const charges = await this.billing.chargesForCalls(found.rows.map((row) => row.id));
    return {
      total: found.total,
      calls: found.rows.map((row) => {
        const charge = charges.get(row.id);
        return {
          ...toPartnerCallView(row),
          earned: charge === undefined ? null : Money.format(charge.partner),
        };
      }),
    };
  }

  /**
   * «Этот вызов ушёл не в мою сеть».
   *
   * Отменяет определение оператора для номера немедленно, не дожидаясь срока годности
   * записи: партнёр видит счёт от своего оператора и знает про ошибку раньше нас.
   *
   * Обращение привязано к вызову, а не к номеру: по номеру можно было бы отменять
   * определение чего угодно, а внешний источник держит два запроса в секунду на всю
   * платформу.
   */
  @Roles('admin')
  @Cabinets('partner')
  @Post('calls/:id/wrong-network')
  @HttpCode(200)
  async reportWrongNetwork(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ invalidated: boolean; destination: string }> {
    return this.reports.reportWrongNetwork(parseId(id, 'call'), {
      userId: actor.userId,
      role: actor.role,
    });
  }
}

function toPartnerCallView(row: CallRow): PartnerCallView {
  return {
    id: row.id,
    destination: row.destination,
    status: row.status,
    sim_card_id: row.simCardId,
    gateway_id: row.gatewayId,
    operator_id: row.operatorId,
    duration_seconds: row.durationSeconds,
    started_at: row.startedAt.toISOString(),
  };
}
