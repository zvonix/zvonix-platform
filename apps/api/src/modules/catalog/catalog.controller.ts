/**
 * HTTP-контракт справочника операторов и определения оператора номера.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { parseId, parseMsisdn } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { BlockedNumberService } from './blocked-numbers.service.js';
import type { BlockedNumberRow } from './blocked-numbers.repository.js';
import { CatalogService, type OperatorView } from './catalog.service.js';
import { OperatorResolverService } from './operator-resolver.service.js';
import { addAliasSchema, blockNumberSchema, createOperatorSchema } from './schemas.js';

/** Оператор в ответе. Идентификаторы — строки: по проводу тип сущности не выражается. */
interface OperatorBrief {
  readonly id: string;
  readonly name: string;
  readonly mnc: string | null;
  readonly is_mvno: boolean;
}

interface ResolutionResponse {
  /** Три разных ответа на вопрос «чей это номер» — см. ADR-0013. */
  readonly range_owner: OperatorBrief | null;
  readonly serving: OperatorBrief | null;
  readonly network: OperatorBrief | null;
  readonly previous_operator: OperatorBrief | null;
  readonly region: string | null;
  readonly source: string | null;
  /** `false` означает отказ в вызове, а не выбор запасного варианта. */
  readonly confirmed: boolean;
  readonly reason: string | null;
}

function brief(
  operator: { id: string; name: string; mnc: string | null; isMvno: boolean } | undefined,
) {
  return operator === undefined
    ? null
    : { id: operator.id, name: operator.name, mnc: operator.mnc, is_mvno: operator.isMvno };
}

interface BlockedNumberView {
  readonly id: string;
  readonly prefix: string;
  readonly note: string;
  readonly created_at: string;
}

@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly resolver: OperatorResolverService,
    private readonly blocked: BlockedNumberService,
  ) {}

  @Roles('admin')
  @Post('operators')
  async create(
    @Body(zodBody(createOperatorSchema)) body: z.infer<typeof createOperatorSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ operator: OperatorView }> {
    const operator = await this.catalog.createOperator(body, {
      userId: actor.userId,
      role: actor.role,
    });
    return { operator };
  }

  @Roles('admin', 'support')
  @Get('operators')
  async list(): Promise<{ operators: OperatorView[] }> {
    return { operators: await this.catalog.listOperators() };
  }

  @Roles('admin')
  @Post('operators/:id/aliases')
  async addAlias(
    @Param('id') id: string,
    @Body(zodBody(addAliasSchema)) body: z.infer<typeof addAliasSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ operator: OperatorView }> {
    const operator = await this.catalog.addAlias(parseId(id, 'operator'), body.alias, actor.userId);
    return { operator };
  }

  /**
   * Определение оператора номера.
   *
   * Помимо диагностики это рабочий инструмент замера: по нему считается доля
   * перенесённых номеров на реальной выборке, от которой зависит, нужен ли платный
   * поставщик вообще.
   */
  @Roles('admin', 'support')
  @Get('numbers/:msisdn/operator')
  async resolve(@Param('msisdn') msisdn: string): Promise<ResolutionResponse> {
    const resolution = await this.resolver.resolve(parseMsisdn(msisdn));
    return {
      range_owner: brief(resolution.rangeOwner),
      serving: brief(resolution.serving),
      network: brief(resolution.network),
      previous_operator: brief(resolution.previousOperator),
      region: resolution.region ?? null,
      source: resolution.source ?? null,
      confirmed: resolution.confirmed,
      reason: resolution.reason ?? null,
    };
  }

  /**
   * Отмена записи об операторе: «вызов ушёл не в мою сеть».
   *
   * Пока доступно администратору. Обращение самого партнёра появится вместе
   * с сущностью партнёра — сейчас проверить, что вызов совершал именно он, нечем.
   */
  @Roles('admin')
  @Post('numbers/:msisdn/invalidate')
  @HttpCode(200)
  async invalidate(@Param('msisdn') msisdn: string): Promise<{ invalidated: boolean }> {
    return { invalidated: await this.resolver.invalidate(parseMsisdn(msisdn)) };
  }

  // --- Чёрный список номеров (ADR-0024) ----------------------------------------

  /**
   * Запретить номер или диапазон.
   *
   * Правило — это префикс; точный номер есть префикс длиной одиннадцать. Префикс
   * принимается так, как его пишет человек: `8-809` приводится к `7809`.
   */
  @Roles('admin')
  @Post('blocked-numbers')
  async block(
    @Body(zodBody(blockNumberSchema)) body: z.infer<typeof blockNumberSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ rule: BlockedNumberView }> {
    const row = await this.blocked.block(body, actor.userId, actor.role);
    return { rule: toBlockedView(row) };
  }

  @Roles('admin', 'support')
  @Get('blocked-numbers')
  async listBlocked(): Promise<{ rules: BlockedNumberView[] }> {
    const rows = await this.blocked.list();
    return { rules: rows.map(toBlockedView) };
  }

  @Roles('admin')
  @Delete('blocked-numbers/:id')
  async unblock(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<{ rule: BlockedNumberView }> {
    const row = await this.blocked.unblock(parseId(id, 'blockedNumber'), actor.userId, actor.role);
    return { rule: toBlockedView(row) };
  }
}

function toBlockedView(row: BlockedNumberRow): BlockedNumberView {
  return {
    id: row.id,
    prefix: row.prefix,
    note: row.note,
    created_at: row.createdAt.toISOString(),
  };
}
