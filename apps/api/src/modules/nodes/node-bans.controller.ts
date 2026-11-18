/**
 * Блокировки fail2ban узла в кабинете ([ADR-0125](../../../../../docs/adr/0125-svoi-adresa-ne-blokiruyutsya.md)):
 * список — администратору и поддержке, снятие — только администратору, с записью в журнал.
 */

import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { NodeBansService, type BanJail } from './node-bans.service.js';
import { unbanSchema } from './schemas.js';

interface NodeBansView {
  readonly available: boolean;
  readonly message: string | null;
  readonly total: number;
  readonly bans: readonly { jail: BanJail; address: string; until: string | null }[];
}

@Controller('nodes')
export class NodeBansController {
  constructor(private readonly bans: NodeBansService) {}

  @Roles('admin', 'support')
  @Get(':id/bans')
  async list(@Param('id') id: string): Promise<NodeBansView> {
    const found = await this.bans.list(parseId(id, 'node'));
    return {
      available: found.available,
      message: found.message,
      total: found.total,
      bans: found.bans.map((ban) => ({
        jail: ban.jail,
        address: ban.address,
        until: ban.until?.toISOString() ?? null,
      })),
    };
  }

  @Roles('admin')
  @Post(':id/bans/unban')
  @HttpCode(200)
  async unban(
    @Param('id') id: string,
    @Body(zodBody(unbanSchema)) body: z.infer<typeof unbanSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ removed: boolean; message: string }> {
    return this.bans.unban(parseId(id, 'node'), body.address, actor.userId, actor.role);
  }
}
