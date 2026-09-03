/**
 * Обращения партнёра: человеческая часть (ADR-0013).
 */

import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import type { Principal } from '../identity/identity.service.js';
import type { CallRow } from './call.repository.js';
import { PartnerReportService } from './partner-report.service.js';

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
  constructor(private readonly reports: PartnerReportService) {}

  /**
   * Вызовы партнёра: по ним он сверяется со счётом своего оператора.
   *
   * Партнёру — только свои, независимо от параметров; администратору и поддержке —
   * названного партнёра.
   */
  @Roles('partner', 'admin', 'support')
  @Get('partner/calls')
  async listCalls(
    @CurrentUser() actor: Principal,
    @Query('partnerId') partnerId?: string,
  ): Promise<{ calls: PartnerCallView[] }> {
    const rows = await this.reports.listCalls(
      { userId: actor.userId, role: actor.role },
      partnerId === undefined ? undefined : parseId(partnerId, 'partner'),
    );
    return { calls: rows.map(toPartnerCallView) };
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
  @Roles('partner', 'admin')
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
