/**
 * Распределение сообщений MAX, которое выбирает партнёр
 * ([ADR-0080](../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)).
 */

import { Body, Controller, Get, Param, Patch, Put } from '@nestjs/common';
import type { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import type { DistributionSettings } from '@zvonix/shared';
import { MessagingService } from './messaging.service.js';
import { distributionSchema, rankSchema } from '../limits/distribution.schemas.js';

interface DistributionView {
  readonly mode: string;
  readonly reserve_percent: number;
  readonly quiet_from_minute: number | null;
  readonly quiet_to_minute: number | null;
  readonly timezone: string;
  readonly sticky_recipient: boolean;
}

interface RankedAccountView {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly weight: number;
  readonly priority: number;
}

const settingsView = (settings: DistributionSettings): DistributionView => ({
  mode: settings.mode,
  reserve_percent: settings.reservePercent,
  quiet_from_minute: settings.quietFromMinute,
  quiet_to_minute: settings.quietToMinute,
  timezone: settings.timezone,
  sticky_recipient: settings.stickyRecipient,
});

@Controller()
export class DistributionController {
  constructor(private readonly messaging: MessagingService) {}

  /** Настройка распределения и аккаунты с весом и приоритетом. */
  @Cabinets('partner')
  @Get('partner/distribution/messages')
  async get(
    @CurrentUser() actor: Principal,
  ): Promise<{ settings: DistributionView; accounts: RankedAccountView[] }> {
    const { settings, accounts } = await this.messaging.distributionOwn(actor.userId);
    return {
      settings: settingsView(settings),
      accounts: accounts.map((account) => ({
        id: account.id,
        label: account.label,
        status: account.status,
        weight: account.distributionWeight,
        priority: account.distributionPriority,
      })),
    };
  }

  @Cabinets('partner')
  @Put('partner/distribution/messages')
  async put(
    @CurrentUser() actor: Principal,
    @Body(zodBody(distributionSchema)) body: z.infer<typeof distributionSchema>,
  ): Promise<{ settings: DistributionView }> {
    const saved = await this.messaging.setDistributionOwn(
      { userId: actor.userId, role: actor.role },
      body,
    );
    return { settings: settingsView(saved) };
  }

  /** Вес и приоритет одного аккаунта. */
  @Cabinets('partner')
  @Patch('partner/messenger/accounts/:id/distribution')
  async rank(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(rankSchema)) body: z.infer<typeof rankSchema>,
  ): Promise<{ account: RankedAccountView }> {
    const account = await this.messaging.setRankOwn(actor.userId, id, body);
    return {
      account: {
        id: account.id,
        label: account.label,
        status: account.status,
        weight: account.distributionWeight,
        priority: account.distributionPriority,
      },
    };
  }
}
