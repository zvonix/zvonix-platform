/**
 * Тарифы партнёров и наценка платформы: человеческая часть (ADR-0010).
 *
 * Записи не редактируются — добавляются новые с датой начала действия. Так история цен
 * остаётся целой, а звонок, тарифицированный вчера, не переоценивается сегодняшней ценой.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Money, parseId, REFERENCE_CALL_SECONDS } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody, zodQuery } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import {
  addCommissionRuleSchema,
  commissionRulesQuerySchema,
  addPartnerRateSchema,
  addPriceBandSchema,
  priceCallSchema,
  createTariffSchema,
  updateTariffSchema,
} from './schemas.js';
import type { CommissionRuleRow, PriceBandRow } from './tariff.repository.js';
import { TariffService, type BandViolation } from './tariff.service.js';
import { toRateView, toTariffView, type RateView, type TariffView } from './views.js';

interface PriceBandView {
  readonly id: string;
  readonly operator_id: string;
  readonly region: string | null;
  readonly min_price: string;
  readonly max_price: string;
  readonly effective_from: string;
}

interface CommissionRuleView {
  readonly id: string;
  readonly client_id: string | null;
  readonly product: string;
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
  ): Promise<{ rate: RateView }> {
    const partnerId = parseId(body.partnerId, 'partner');
    const row = await this.tariffs.addPartnerRate(
      {
        partnerId,
        tariffId:
          body.tariffId === undefined
            ? (await this.tariffs.defaultTariff(partnerId)).id
            : parseId(body.tariffId, 'partnerTariff'),
        operatorId: body.operatorId == null ? null : parseId(body.operatorId, 'operator'),
        terminationKind: body.terminationKind,
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
  async listPartnerRates(@Query('partnerId') partnerId: string): Promise<{ rates: RateView[] }> {
    const rows = await this.tariffs.listPartnerRates(parseId(partnerId, 'partner'));
    return { rates: rows.map(toRateView) };
  }

  // --- Тарифы партнёра (ADR-0056) ---------------------------------------------

  @Roles('admin', 'support')
  @Get('partners/:partnerId/tariffs')
  async listTariffs(@Param('partnerId') partnerId: string): Promise<{ tariffs: TariffView[] }> {
    const rows = await this.tariffs.listTariffs(parseId(partnerId, 'partner'));
    return { tariffs: rows.map(toTariffView) };
  }

  @Roles('admin')
  @Post('partners/:partnerId/tariffs')
  async createTariff(
    @Param('partnerId') partnerId: string,
    @Body(zodBody(createTariffSchema)) body: z.infer<typeof createTariffSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ tariff: TariffView }> {
    const row = await this.tariffs.createTariff(parseId(partnerId, 'partner'), body.name, actor);
    return { tariff: toTariffView(row) };
  }

  @Roles('admin')
  @Patch('partners/:partnerId/tariffs/:tariffId')
  async updateTariff(
    @Param('partnerId') partnerId: string,
    @Param('tariffId') tariffId: string,
    @Body(zodBody(updateTariffSchema)) body: z.infer<typeof updateTariffSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ tariff: TariffView }> {
    const row = await this.tariffs.updateTariff(
      parseId(partnerId, 'partner'),
      parseId(tariffId, 'partnerTariff'),
      body,
      actor,
    );
    return { tariff: toTariffView(row) };
  }

  @Roles('admin')
  @Delete('partners/:partnerId/tariffs/:tariffId')
  @HttpCode(204)
  async deleteTariff(
    @Param('partnerId') partnerId: string,
    @Param('tariffId') tariffId: string,
    @CurrentUser() actor: Principal,
  ): Promise<void> {
    await this.tariffs.deleteTariff(
      parseId(partnerId, 'partner'),
      parseId(tariffId, 'partnerTariff'),
      actor,
    );
  }

  // --- Коридоры цен (ADR-0023) -------------------------------------------------

  /**
   * Границы — стоимость эталонного вызова, а не цена за минуту.
   *
   * Коридор по одной цене за минуту обходится платой за соединение или минимальной
   * длительностью в десять минут, то есть не ограничивает ничего.
   */
  @Roles('admin')
  @Post('price-bands')
  async addPriceBand(
    @Body(zodBody(addPriceBandSchema)) body: z.infer<typeof addPriceBandSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ band: PriceBandView }> {
    const row = await this.tariffs.addPriceBand(
      {
        operatorId: parseId(body.operatorId, 'operator'),
        region: body.region ?? null,
        minPrice: body.minPrice,
        maxPrice: body.maxPrice,
        effectiveFrom: body.effectiveFrom === undefined ? new Date() : new Date(body.effectiveFrom),
      },
      actor.userId,
      actor.role,
    );
    return { band: toBandView(row) };
  }

  @Roles('admin', 'support')
  @Get('price-bands')
  async listPriceBands(
    @Query('operatorId') operatorId?: string,
  ): Promise<{ bands: PriceBandView[] }> {
    const rows = await this.tariffs.listPriceBands(
      operatorId === undefined ? undefined : parseId(operatorId, 'operator'),
    );
    return { bands: rows.map(toBandView) };
  }

  /**
   * Действующие цены, оказавшиеся вне действующего коридора.
   *
   * Возникает от **сужения коридора после** назначения цены: строка тарифа неизменяема,
   * и переписывать её значило бы переоценивать прошлое. Без этого списка правило тихо
   * перестало бы выполняться, и узнать об этом было бы неоткуда.
   */
  @Roles('admin', 'support')
  @Get('price-bands/violations')
  async bandViolations(): Promise<{
    violations: {
      rate: RateView;
      band: PriceBandView;
      reference_cost: string;
      reference_call_seconds: number;
    }[];
  }> {
    const found = await this.tariffs.findBandViolations(new Date());
    return { violations: found.map(toViolationView) };
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
        product: body.product,
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
  async listCommissionRules(
    @Query(zodQuery(commissionRulesQuerySchema)) query: z.infer<typeof commissionRulesQuerySchema>,
  ): Promise<{ rules: CommissionRuleView[] }> {
    const rows = await this.tariffs.listCommissionRules(query.product);
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
      body.terminationKind,
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

function toBandView(row: PriceBandRow): PriceBandView {
  return {
    id: row.id,
    operator_id: row.operatorId,
    region: row.region,
    min_price: Money.format(row.minPrice),
    max_price: Money.format(row.maxPrice),
    effective_from: row.effectiveFrom.toISOString(),
  };
}

function toViolationView(violation: BandViolation): {
  rate: RateView;
  band: PriceBandView;
  reference_cost: string;
  reference_call_seconds: number;
} {
  return {
    rate: toRateView(violation.rate),
    band: toBandView(violation.band),
    reference_cost: Money.format(violation.referenceCost),
    reference_call_seconds: REFERENCE_CALL_SECONDS,
  };
}

function toCommissionView(row: CommissionRuleRow): CommissionRuleView {
  return {
    id: row.id,
    client_id: row.clientId,
    product: row.product,
    fixed_fee: Money.format(row.fixedFee),
    percent_basis_points: row.percentBasisPoints.toString(),
    effective_from: row.effectiveFrom.toISOString(),
  };
}
