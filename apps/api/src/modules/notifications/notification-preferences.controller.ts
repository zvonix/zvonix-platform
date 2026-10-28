/**
 * Какие письма получать — выбирает сам клиент или партнёр
 * ([ADR-0104](../../../../../docs/adr/0104-pisma-nastraivaet-sam-poluchatel.md)).
 *
 * Владелец выводится из сессии. Рядом с выбором — включено ли письмо на площадке: выключенное там не уйдёт, что бы
 * человек ни выбрал, и кабинет должен это сказать, а не обещать письмо.
 */

import { Body, Controller, Get, Put } from '@nestjs/common';
import { Money } from '@zvonix/shared';
import { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { BillingService } from '../billing/billing.service.js';
import type { Principal } from '../identity/identity.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  NotificationPreferencesService,
  type ChoiceChanges,
  type NotificationChoice,
} from './notification-preferences.service.js';

/** Свой порог «мало денег», целых рублей (ADR-0104, п. 5). */
const LOW_BALANCE_THRESHOLD_MAX = 10_000_000;

const MICROS_PER_RUBLE = 1_000_000n;

const clientNotificationsSchema = z
  .object({
    lowBalance: z.boolean(),
    lowBalanceThreshold: z
      .number()
      .int('целое число рублей')
      .min(1, 'не меньше 1 ₽')
      .max(LOW_BALANCE_THRESHOLD_MAX, 'не больше 10 000 000 ₽')
      .nullable(),
    paymentDecision: z.boolean(),
  })
  .partial()
  .strict();

const partnerNotificationsSchema = z
  .object({ equipmentSuspended: z.boolean(), poorConnection: z.boolean() })
  .partial()
  .strict();

interface Letter {
  /** Выбор человека. */
  readonly enabled: boolean;
  /** Рассылает ли такие письма площадка: выключено — не уйдёт никому. */
  readonly platform_enabled: boolean;
}

interface ClientNotificationsView {
  readonly low_balance: Letter & {
    /** Свой порог, рублей; пусто — порог площадки. */
    readonly threshold: number | null;
    readonly platform_threshold: number;
  };
  readonly payment_decision: Letter;
}

interface PartnerNotificationsView {
  readonly equipment_suspended: Letter;
  readonly poor_connection: Letter;
}

@Controller()
export class NotificationPreferencesController {
  constructor(
    private readonly preferences: NotificationPreferencesService,
    private readonly billing: BillingService,
    private readonly settings: SettingsService,
  ) {}

  @Cabinets('client')
  @Get('client/notifications')
  async client(@CurrentUser() actor: Principal): Promise<ClientNotificationsView> {
    await this.billing.requireClientOwnedBy(actor.userId);
    return this.clientView(await this.preferences.of(actor.userId));
  }

  @Cabinets('client')
  @Put('client/notifications')
  async changeClient(
    @CurrentUser() actor: Principal,
    @Body(zodBody(clientNotificationsSchema)) body: z.infer<typeof clientNotificationsSchema>,
  ): Promise<ClientNotificationsView> {
    await this.billing.requireClientOwnedBy(actor.userId);
    const { lowBalanceThreshold, ...flags } = body;
    const changes: ChoiceChanges = {
      ...flags,
      ...(lowBalanceThreshold === undefined
        ? {}
        : {
            lowBalanceThreshold:
              lowBalanceThreshold === null
                ? null
                : Money.fromMicros(BigInt(lowBalanceThreshold) * MICROS_PER_RUBLE),
          }),
    };
    return this.clientView(await this.preferences.change(actor.userId, changes));
  }

  @Cabinets('partner')
  @Get('partner/notifications')
  async partner(@CurrentUser() actor: Principal): Promise<PartnerNotificationsView> {
    await this.billing.requirePartnerOwnedBy(actor.userId);
    return this.partnerView(await this.preferences.of(actor.userId));
  }

  @Cabinets('partner')
  @Put('partner/notifications')
  async changePartner(
    @CurrentUser() actor: Principal,
    @Body(zodBody(partnerNotificationsSchema)) body: z.infer<typeof partnerNotificationsSchema>,
  ): Promise<PartnerNotificationsView> {
    await this.billing.requirePartnerOwnedBy(actor.userId);
    return this.partnerView(await this.preferences.change(actor.userId, body));
  }

  private async clientView(choice: NotificationChoice): Promise<ClientNotificationsView> {
    const platform = await this.settings.notifications();
    return {
      low_balance: {
        enabled: choice.lowBalance,
        platform_enabled: platform.lowBalanceEnabled && platform.lowBalanceAmount > 0,
        threshold:
          choice.lowBalanceThreshold === null
            ? null
            : Number(Money.toMicros(choice.lowBalanceThreshold) / MICROS_PER_RUBLE),
        platform_threshold: platform.lowBalanceAmount,
      },
      payment_decision: {
        enabled: choice.paymentDecision,
        platform_enabled: platform.paymentDecisionEnabled,
      },
    };
  }

  private async partnerView(choice: NotificationChoice): Promise<PartnerNotificationsView> {
    const { partnerSuspensionEnabled } = await this.settings.notifications();
    return {
      equipment_suspended: {
        enabled: choice.equipmentSuspended,
        platform_enabled: partnerSuspensionEnabled,
      },
      poor_connection: {
        enabled: choice.poorConnection,
        platform_enabled: partnerSuspensionEnabled,
      },
    };
  }
}
