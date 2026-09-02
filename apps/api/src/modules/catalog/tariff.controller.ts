/**
 * Тарифы партнёров и наценка платформы: человеческая часть (ADR-0010).
 *
 * Записи не редактируются — добавляются новые с датой начала действия. Так история цен
 * остаётся целой, а звонок, тарифицированный вчера, не переоценивается сегодняшней ценой.
 */

import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Money, parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { addCommissionRuleSchema, addPartnerRateSchema, priceCallSchema } from './schemas.js';
import type { CommissionRuleRow, PartnerRateRow } from './tariff.repository.js';
import { TariffService } from './tariff.service.js';

interface PartnerRateView {
  readonly id: string;
  readonly partner_id: string;
  readonly operator_id: string;
  readonly region: string | null;
  readonly price_per_minute: string;
  readonly billing_increment_seconds: number;
  readonly minimum_duration_seconds: number;
  readonly connection_fee: string;
  readonly rounding: string;
  readonly effective_from: string;
}

interface CommissionRuleView {
  readonly id: string;
  readonly client_id: string | null;
  readonly fixed_fee: string;
  readonly percent_basis_points: string;
  readonly effective_from: string;
}

@Controller()
export class TariffController {
  constructor(private readonly tariffs: TariffService) {}

  @Roles('admin')
  @Post('partner-rates')
  async addPartnerRate(
    @Body(zodBody(addPartnerRateSchema)) body: z.infer<typeof addPartnerRateSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ rate: PartnerRateView }> {
    const row = await this.tariffs.addPartnerRate(
      {
        partnerId: parseId(body.partnerId, 'partner'),
        operatorId: parseId(body.operatorId, 'operator'),
        region: body.region ?? null,
        pricePerMinute: body.pricePerMinute,
        billingIncrementSeconds: body.billingIncrementSeconds,
        minimumDurationSeconds: body.minimumDurationSeconds,
        connectionFee: body.connectionFee ?? Money.ZERO,
        rounding: body.rounding,
        effectiveFrom: body.effectiveFrom === undefined ? new Date() : new Date(body.effectiveFrom),
      },
      actor.userId,
      actor.role,
    );
    return { rate: toRateView(row) };
  }

  @Roles('admin', 'support')
  @Get('partner-rates')
  async listPartnerRates(
    @Query('partnerId') partnerId: string,
  ): Promise<{ rates: PartnerRateView[] }> {
    const rows = await this.tariffs.listPartnerRates(parseId(partnerId, 'partner'));
    return { rates: rows.map(toRateView) };
  }

  @Roles('admin')
  @Post('commission-rules')
  async addCommissionRule(
    @Body(zodBody(addCommissionRuleSchema)) body: z.infer<typeof addCommissionRuleSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ rule: CommissionRuleView }> {
    const row = await this.tariffs.addCommissionRule(
      {
        clientId: body.clientId === undefined ? null : parseId(body.clientId, 'client'),
        fixedFee: body.fixedFee ?? Money.ZERO,
        percentBasisPoints: BigInt(body.percentBasisPoints),
        effectiveFrom: body.effectiveFrom === undefined ? new Date() : new Date(body.effectiveFrom),
      },
      actor.userId,
      actor.role,
    );
    return { rule: toCommissionView(row) };
  }

  @Roles('admin', 'support')
  @Get('commission-rules')
  async listCommissionRules(): Promise<{ rules: CommissionRuleView[] }> {
    const rows = await this.tariffs.listCommissionRules();
    return { rules: rows.map(toCommissionView) };
  }

  /**
   * Во сколько обойдётся вызов заданной длительности.
   *
   * Нужен для двух разговоров, которые случаются постоянно: «почему списали столько»
   * и «сколько будет стоить». Отвечать на них по коду тарификации неудобно, а по логам
   * невозможно.
   */
  @Roles('admin', 'support')
  @Post('tariffs/price')
  async priceCall(@Body(zodBody(priceCallSchema)) body: z.infer<typeof priceCallSchema>): Promise<{
    billed_seconds: number;
    partner_amount: string;
    commission_amount: string;
    client_amount: string;
    rate_id: string;
    commission_rule_id: string;
  }> {
    const at = body.at === undefined ? new Date() : new Date(body.at);
    const priced = await this.tariffs.priceCall(
      parseId(body.partnerId, 'partner'),
      parseId(body.clientId, 'client'),
      { operatorId: parseId(body.operatorId, 'operator'), region: body.region ?? null },
      body.durationSeconds,
      at,
    );

    return {
      billed_seconds: priced.charge.billedSeconds,
      partner_amount: Money.format(priced.charge.partnerAmount),
      commission_amount: Money.format(priced.charge.commissionAmount),
      client_amount: Money.format(priced.charge.clientAmount),
      rate_id: priced.applied.rateId,
      commission_rule_id: priced.applied.commissionRuleId,
    };
  }
}

function toRateView(row: PartnerRateRow): PartnerRateView {
  return {
    id: row.id,
    partner_id: row.partnerId,
    operator_id: row.operatorId,
    region: row.region,
    price_per_minute: Money.format(row.pricePerMinute),
    billing_increment_seconds: row.billingIncrementSeconds,
    minimum_duration_seconds: row.minimumDurationSeconds,
    connection_fee: Money.format(row.connectionFee),
    rounding: row.rounding,
    effective_from: row.effectiveFrom.toISOString(),
  };
}

function toCommissionView(row: CommissionRuleRow): CommissionRuleView {
  return {
    id: row.id,
    client_id: row.clientId,
    fixed_fee: Money.format(row.fixedFee),
    percent_basis_points: row.percentBasisPoints.toString(),
    effective_from: row.effectiveFrom.toISOString(),
  };
}
