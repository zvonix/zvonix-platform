/**
 * Сводки для трёх ролей ([ADR-0059](../../../../../docs/adr/0059-otchyoty-i-svodki.md)).
 *
 * Расчёт один, а ответ у каждой роли свой — по ADR-0014: клиент не видит партнёра и его
 * долю, партнёр не видит клиента и его цену, маржу видят только сотрудники. Поэтому виды
 * ответа собираются здесь явно, а не отдаются как есть.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { validationFailed } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets, Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodQuery } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import type { BreakdownRow, Dimension, Metrics } from './reports.repository.js';
import { ReportsService, rubles, type Overview } from './reports.service.js';
import { breakdownQuerySchema, overviewQuerySchema } from './schemas.js';

type OverviewQuery = z.infer<typeof overviewQuerySchema>;
type BreakdownQuery = z.infer<typeof breakdownQuerySchema>;

/** Общая часть каждого вида: вызовы, состоявшиеся, минуты разговора. */
const common = (metrics: Metrics) => ({
  calls: metrics.calls,
  answered: metrics.answered,
  talk_seconds: metrics.talkSeconds,
});

const staffView = (metrics: Metrics) => ({
  ...common(metrics),
  revenue: rubles(metrics.clientAmount),
  partner_cost: rubles(metrics.partnerAmount),
  margin: rubles(metrics.margin),
});
const clientView = (metrics: Metrics) => ({
  ...common(metrics),
  spent: rubles(metrics.clientAmount),
});
const partnerView = (metrics: Metrics) => ({
  ...common(metrics),
  earned: rubles(metrics.partnerAmount),
});

function overviewOf<T extends object>(overview: Overview, view: (metrics: Metrics) => T) {
  return {
    days: overview.days,
    from: overview.from.toISOString(),
    to: overview.to.toISOString(),
    totals: view(overview.totals),
    series: overview.series.map((row) => ({ day: row.day, ...view(row) })),
  };
}

const breakdownOf = <T extends object>(rows: BreakdownRow[], view: (metrics: Metrics) => T) => ({
  rows: rows.map((row) => ({ key: row.key, name: row.name, ...view(row) })),
});

/** Разрез, недоступный роли, — отказ проверки, а не пустой ответ. */
function allow(by: Dimension, allowed: readonly Dimension[]): void {
  if (!allowed.includes(by)) throw validationFailed('Такого разреза в этом кабинете нет');
}

@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly billing: BillingService,
  ) {}

  @Roles('admin', 'support')
  @Get('reports/overview')
  async overview(@Query(zodQuery(overviewQuerySchema)) query: OverviewQuery) {
    const overview = await this.reports.overview({ kind: 'all' }, query.days, query.offset);
    return overviewOf(overview, staffView);
  }

  @Roles('admin', 'support')
  @Get('reports/breakdown')
  async breakdown(@Query(zodQuery(breakdownQuerySchema)) query: BreakdownQuery) {
    const rows = await this.reports.breakdown({ kind: 'all' }, query.days, query.offset, query.by);
    return breakdownOf(rows, staffView);
  }

  @Cabinets('client')
  @Get('client/reports/overview')
  async clientOverview(
    @CurrentUser() actor: Principal,
    @Query(zodQuery(overviewQuerySchema)) query: OverviewQuery,
  ) {
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const overview = await this.reports.overview(
      { kind: 'client', clientId: client.id },
      query.days,
      query.offset,
    );
    return overviewOf(overview, clientView);
  }

  @Cabinets('client')
  @Get('client/reports/breakdown')
  async clientBreakdown(
    @CurrentUser() actor: Principal,
    @Query(zodQuery(breakdownQuerySchema)) query: BreakdownQuery,
  ) {
    allow(query.by, ['operator', 'channel']);
    const client = await this.billing.requireClientOwnedBy(actor.userId);
    const rows = await this.reports.breakdown(
      { kind: 'client', clientId: client.id },
      query.days,
      query.offset,
      query.by,
    );
    return breakdownOf(rows, clientView);
  }

  @Cabinets('partner')
  @Get('partner/reports/overview')
  async partnerOverview(
    @CurrentUser() actor: Principal,
    @Query(zodQuery(overviewQuerySchema)) query: OverviewQuery,
  ) {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const overview = await this.reports.overview(
      { kind: 'partner', partnerId: partner.id },
      query.days,
      query.offset,
    );
    return overviewOf(overview, partnerView);
  }

  @Cabinets('partner')
  @Get('partner/reports/breakdown')
  async partnerBreakdown(
    @CurrentUser() actor: Principal,
    @Query(zodQuery(breakdownQuerySchema)) query: BreakdownQuery,
  ) {
    allow(query.by, ['sim', 'gateway', 'operator']);
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const rows = await this.reports.breakdown(
      { kind: 'partner', partnerId: partner.id },
      query.days,
      query.offset,
      query.by,
    );
    return breakdownOf(rows, partnerView);
  }
}
