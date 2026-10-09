/**
 * Лимиты, которые партнёр задаёт себе сам
 * ([ADR-0057](../../../../../docs/adr/0057-limity-partnyora.md)).
 *
 * Это защита его же карт: оператор блокирует SIM за нечеловеческий профиль трафика.
 * Партнёр задаёт звонки в минуту, час, сутки, неделю, месяц и пакет минут —
 * на себя целиком, «на каждую карту» или на одну карту. Лимиты площадки ему видны,
 * но не меняются.
 *
 * Здесь, а не в модуле лимитов: владение картой проверяет телефония, а модуль лимитов
 * о картах не знает (и знать не должен — телефония сама зависит от него).
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { parseId, permissionDenied, type Id } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { PartnerRow } from '../billing/billing.repository.js';
import type { Principal } from '../identity/identity.service.js';
import type { LimitRuleRow } from '../limits/limit.repository.js';
import { TariffService } from '../catalog/tariff.service.js';
import { LimitService } from '../limits/limit.service.js';
import { changeLimitSchema, partnerLimitSchema } from '../limits/schemas.js';
import { toLimitView, toUsageView, type LimitUsageView, type LimitView } from '../limits/views.js';
import { TelephonyService } from './telephony.service.js';

@Controller()
export class PartnerLimitsController {
  constructor(
    private readonly limits: LimitService,
    private readonly telephony: TelephonyService,
    private readonly billing: BillingService,
    private readonly tariffs: TariffService,
  ) {}

  /**
   * Свои лимиты и лимиты площадки — с израсходованным и моментом обнуления.
   * У правила «на каждую карту» и у лимита в тарифе — по строке на каждую карту.
   */
  @Cabinets('partner')
  @Get('partner/limits')
  async list(@CurrentUser() actor: Principal): Promise<{
    limits: LimitUsageView[];
    /** Сами лимиты тарифов — и тех, где пока нет карт: строк остатков у них нет. */
    tariff_limits: LimitView[];
    sims: { id: string; msisdn: string; tariff_id: string }[];
    tariffs: { id: string; name: string; is_default: boolean }[];
  }> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    const [allSims, tariffOfSim, tariffs] = await Promise.all([
      this.telephony.listSims(partner.id),
      this.telephony.simTariffs(partner.id),
      this.tariffs.listTariffs(partner.id),
    ]);
    const sims = allSims.filter((sim) => sim.status !== 'retired');
    const tariffRules = await this.limits.rules({ tariffIds: tariffs.map((tariff) => tariff.id) });
    const usage = await this.limits.usage(
      {
        partnerIds: [partner.id],
        simCardIds: sims.map((sim) => sim.id),
        tariffIds: tariffs.map((tariff) => tariff.id),
      },
      new Date(),
      sims.map((sim) => ({
        partnerId: partner.id,
        simCardId: sim.id,
        tariffId: tariffOfSim.get(sim.id) ?? null,
      })),
    );
    return {
      limits: usage.map(toUsageView),
      tariff_limits: tariffRules.map(toLimitView),
      sims: sims.flatMap((sim) => {
        const tariffId = tariffOfSim.get(sim.id);
        return tariffId === undefined
          ? []
          : [{ id: sim.id, msisdn: sim.msisdn, tariff_id: tariffId }];
      }),
      tariffs: tariffs.map((tariff) => ({
        id: tariff.id,
        name: tariff.name,
        is_default: tariff.isDefault,
      })),
    };
  }

  @Cabinets('partner')
  @Post('partner/limits')
  async add(
    @CurrentUser() actor: Principal,
    @Body(zodBody(partnerLimitSchema)) body: z.infer<typeof partnerLimitSchema>,
  ): Promise<{ limit: LimitView }> {
    const partner = await this.editablePartner(actor);
    let simCardId: Id<'simCard'> | null = null;
    if (body.scope === 'sim' && body.simCardId !== undefined) {
      simCardId = parseId(body.simCardId, 'simCard');
      await this.telephony.requireOwnSim(simCardId, partner.id);
    }
    // Лимит в тарифе: тариф должен быть этого партнёра, иначе это лимит на чужие карты.
    let tariffId: Id<'partnerTariff'> | null = null;
    if (body.scope === 'tariff' && body.tariffId !== undefined) {
      const tariff = await this.tariffs.requireTariffOf(
        partner.id,
        parseId(body.tariffId, 'partnerTariff'),
      );
      tariffId = tariff.id;
    }
    const row = await this.limits.add(
      {
        clientId: null,
        channelId: null,
        partnerId: body.scope === 'sim' || body.scope === 'tariff' ? null : partner.id,
        simCardId,
        tariffId,
        window: body.window,
        metric: body.metric,
        value: body.value,
        perSim: body.scope === 'each_sim',
        rounding: body.rounding,
        periodStartDay: body.periodStartDay ?? null,
        setBy: 'partner',
      },
      actor.userId,
      actor.role,
    );
    return { limit: toLimitView(row) };
  }

  @Cabinets('partner')
  @Patch('partner/limits/:id')
  async change(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(changeLimitSchema)) body: z.infer<typeof changeLimitSchema>,
  ): Promise<{ limit: LimitView }> {
    const partner = await this.editablePartner(actor);
    const row = await this.limits.changeRule(
      parseId(id, 'limitRule'),
      body,
      actor,
      await this.ownerCheck(partner),
    );
    return { limit: toLimitView(row) };
  }

  @Cabinets('partner')
  @Delete('partner/limits/:id')
  @HttpCode(204)
  async remove(@CurrentUser() actor: Principal, @Param('id') id: string): Promise<void> {
    const partner = await this.editablePartner(actor);
    await this.limits.remove(parseId(id, 'limitRule'), actor, await this.ownerCheck(partner));
  }

  /** Своё правило — на себя, на свою карту или в своём тарифе. Чужое для партнёра не существует. */
  private async ownerCheck(partner: PartnerRow): Promise<(rule: LimitRuleRow) => boolean> {
    const [sims, tariffs] = await Promise.all([
      this.telephony.listSims(partner.id),
      this.tariffs.listTariffs(partner.id),
    ]);
    const ownSims = new Set<string>(sims.map((sim) => sim.id));
    const ownTariffs = new Set<string>(tariffs.map((tariff) => tariff.id));
    return (rule) =>
      rule.partnerId === partner.id ||
      (rule.simCardId !== null && ownSims.has(rule.simCardId)) ||
      (rule.tariffId !== null && ownTariffs.has(rule.tariffId));
  }

  /** Закрытый партнёр не меняет ничего: запись осталась бы от участника, которого нет. */
  private async editablePartner(actor: Principal): Promise<PartnerRow> {
    const partner = await this.billing.requirePartnerOwnedBy(actor.userId);
    if (partner.status === 'closed') {
      throw permissionDenied('Партнёр закрыт: изменения недоступны');
    }
    return partner;
  }
}
