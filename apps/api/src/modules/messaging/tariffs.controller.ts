/**
 * Тарифы MAX партнёра ([ADR-0075](../../../../../docs/adr/0075-tarify-max-nabor-uslovij.md)): список, создание,
 * правка, «по умолчанию», удаление и назначение аккаунту. Только свой кабинет партнёра.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { Money } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { assignTariffSchema, createTariffSchema, updateTariffSchema } from './schemas.js';
import type { MessengerTariffRow } from './tariffs.repository.js';
import { MessengerTariffsService } from './tariffs.service.js';

interface TariffJson {
  readonly id: string;
  readonly name: string;
  readonly price: string;
  readonly limit_per_minute: number | null;
  readonly limit_per_day: number | null;
  readonly is_default: boolean;
  /** Сколько живых аккаунтов действует по этому тарифу. */
  readonly accounts: number;
}

const toJson = (row: MessengerTariffRow, accounts: number): TariffJson => ({
  id: row.id,
  name: row.name,
  price: Money.format(row.price),
  limit_per_minute: row.limitPerMinute,
  limit_per_day: row.limitPerDay,
  is_default: row.isDefault,
  accounts,
});

@Controller()
export class MessengerTariffsController {
  constructor(private readonly tariffs: MessengerTariffsService) {}

  @Cabinets('partner')
  @Get('partner/messenger/tariffs')
  async list(@CurrentUser() actor: Principal): Promise<{ tariffs: TariffJson[] }> {
    const views = await this.tariffs.list(actor.userId);
    return { tariffs: views.map((item) => toJson(item.row, item.accounts)) };
  }

  @Cabinets('partner')
  @Post('partner/messenger/tariffs')
  async create(
    @CurrentUser() actor: Principal,
    @Body(zodBody(createTariffSchema)) body: z.infer<typeof createTariffSchema>,
  ): Promise<{ tariff: TariffJson }> {
    const row = await this.tariffs.create({ userId: actor.userId, role: actor.role }, body);
    return { tariff: toJson(row, 0) };
  }

  @Cabinets('partner')
  @Patch('partner/messenger/tariffs/:id')
  async update(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(updateTariffSchema)) body: z.infer<typeof updateTariffSchema>,
  ): Promise<{ tariff: TariffJson }> {
    const row = await this.tariffs.update({ userId: actor.userId, role: actor.role }, id, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.price === undefined ? {} : { price: body.price }),
      ...(body.limitPerMinute === undefined ? {} : { limitPerMinute: body.limitPerMinute }),
      ...(body.limitPerDay === undefined ? {} : { limitPerDay: body.limitPerDay }),
    });
    return { tariff: toJson(row, 0) };
  }

  /** Сделать тариф умолчанием: аккаунты без своего тарифа переходят на него. */
  @Cabinets('partner')
  @HttpCode(204)
  @Post('partner/messenger/tariffs/:id/default')
  async makeDefault(@CurrentUser() actor: Principal, @Param('id') id: string): Promise<void> {
    await this.tariffs.makeDefault({ userId: actor.userId, role: actor.role }, id);
  }

  @Cabinets('partner')
  @HttpCode(204)
  @Delete('partner/messenger/tariffs/:id')
  async remove(@CurrentUser() actor: Principal, @Param('id') id: string): Promise<void> {
    await this.tariffs.remove({ userId: actor.userId, role: actor.role }, id);
  }

  /** Назначает аккаунту тариф (`tariffId: null` — идти за умолчанием). Отвечает действующими условиями аккаунта. */
  @Cabinets('partner')
  @Put('partner/messenger/accounts/:id/tariff')
  async assign(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(assignTariffSchema)) body: z.infer<typeof assignTariffSchema>,
  ): Promise<{
    tariff_id: string | null;
    price: string | null;
    limit_per_minute: number | null;
    limit_per_day: number | null;
  }> {
    const row = await this.tariffs.assign(
      { userId: actor.userId, role: actor.role },
      id,
      body.tariffId,
    );
    return {
      tariff_id: row.tariffId,
      price: row.price === null ? null : Money.format(row.price),
      limit_per_minute: row.limitPerMinute,
      limit_per_day: row.limitPerDay,
    };
  }
}
