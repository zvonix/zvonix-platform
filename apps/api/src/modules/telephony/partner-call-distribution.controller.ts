/**
 * Распределение звонков между картами, которое выбирает партнёр
 * ([ADR-0080](../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)). Клиентский приоритет и цена остаются
 * первыми; настройка меняет порядок внутри одного партнёра и одной цены.
 */

import { Body, Controller, Get, Param, Patch, Put } from '@nestjs/common';
import { parseId, type DistributionSettings } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import { distributionSchema, rankSchema } from '../limits/distribution.schemas.js';
import { DistributionService } from '../limits/distribution.service.js';
import { TelephonyService } from './telephony.service.js';

interface SimRankView {
  readonly id: string;
  readonly msisdn: string;
  readonly status: string;
  readonly weight: number;
  readonly priority: number;
}

const settingsView = (settings: DistributionSettings) => ({
  mode: settings.mode,
  reserve_percent: settings.reservePercent,
  quiet_from_minute: settings.quietFromMinute,
  quiet_to_minute: settings.quietToMinute,
  timezone: settings.timezone,
  sticky_recipient: settings.stickyRecipient,
});

@Controller()
export class PartnerCallDistributionController {
  constructor(
    private readonly distribution: DistributionService,
    private readonly telephony: TelephonyService,
    private readonly billing: BillingService,
  ) {}

  /** Настройка распределения звонков и карты с весом и приоритетом. */
  @Cabinets('partner')
  @Get('partner/distribution/calls')
  async get(@CurrentUser() actor: Principal): Promise<{
    settings: ReturnType<typeof settingsView>;
    sims: SimRankView[];
  }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const sims = (await this.telephony.listSims(partner.id)).filter(
      (sim) => sim.status !== 'retired',
    );
    return {
      settings: settingsView(await this.distribution.get(partner.id, 'call')),
      sims: sims.map((sim) => ({
        id: sim.id,
        msisdn: sim.msisdn,
        status: sim.status,
        weight: sim.distributionWeight,
        priority: sim.distributionPriority,
      })),
    };
  }

  @Cabinets('partner')
  @Put('partner/distribution/calls')
  async put(
    @CurrentUser() actor: Principal,
    @Body(zodBody(distributionSchema)) body: z.infer<typeof distributionSchema>,
  ): Promise<{ settings: ReturnType<typeof settingsView> }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const saved = await this.distribution.save(
      { userId: actor.userId, role: actor.role },
      partner.id,
      'call',
      body,
    );
    return { settings: settingsView(saved) };
  }

  /** Вес и приоритет одной карты. */
  @Cabinets('partner')
  @Patch('partner/sims/:id/distribution')
  async rank(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(rankSchema)) body: z.infer<typeof rankSchema>,
  ): Promise<{ sim: SimRankView }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const own = await this.telephony.requireOwnSim(parseId(id, 'simCard'), partner.id);
    const sim = await this.telephony.setSimRank(own.id, body);
    return {
      sim: {
        id: sim.id,
        msisdn: sim.msisdn,
        status: sim.status,
        weight: sim.distributionWeight,
        priority: sim.distributionPriority,
      },
    };
  }
}
