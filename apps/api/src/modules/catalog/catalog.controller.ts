/**
 * HTTP-контракт справочника операторов и определения оператора номера.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { isStaffRole, parseId, parseMsisdn } from '@zvonix/shared';
import type { z } from 'zod';
import { Cabinets, Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { BlockedNumberService } from './blocked-numbers.service.js';
import type { BlockedNumberRow } from './blocked-numbers.repository.js';
import { CatalogService, type OperatorView } from './catalog.service.js';
import { OperatorResolverService, type OperatorResolution } from './operator-resolver.service.js';
import {
  addAliasSchema,
  blockNumberSchema,
  createOperatorSchema,
  confirmNumberOperatorSchema,
  verifyOperatorSchema,
} from './schemas.js';

/**
 * Оператор в ответе администратору и поддержке.
 *
 * Поля наружу — `snake_case`, как во всех остальных ответах API: внутренний `camelCase`
 * службы наружу не выносится (CONVENTIONS.md).
 */
interface OperatorResponse {
  readonly id: string;
  readonly name: string;
  readonly inn: string | null;
  readonly mnc: string | null;
  readonly is_mvno: boolean;
  readonly host_operator_id: string | null;
  /**
   * `null` — запись завёл импорт плана нумерации и человек её не смотрел
   * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
   * Вызов по такому оператору не совершается: `is_mvno` в ней не факт, а умолчание.
   */
  readonly verified_at: string | null;
  readonly aliases: readonly string[];
}

/**
 * Оператор в ответе клиенту: только то, из чего он выбирает.
 *
 * ИНН, MNC и связи MVNO клиенту не нужны ни для чего — он выбирает разрешённых
 * операторов канала (ADR-0025), а не ведёт справочник. Отдавать больше нужного
 * незачем: сузить ответ позже сложнее, чем не расширять его сейчас.
 */
interface OperatorChoice {
  readonly id: string;
  readonly name: string;
}

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
  ): Promise<{ operator: OperatorResponse }> {
    const operator = await this.catalog.createOperator(body, {
      userId: actor.userId,
      role: actor.role,
    });
    return { operator: toOperatorResponse(operator) };
  }

  /**
   * Человек подтверждает запись оператора, заведённую импортом
   * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
   *
   * До подтверждения по такому оператору не звонят: файл плана нумерации не сообщает,
   * виртуальный он или нет, а ошибка в этом — деньги партнёра.
   */
  @Roles('admin')
  @Post('operators/:id/verify')
  async verify(
    @Param('id') id: string,
    @Body(zodBody(verifyOperatorSchema)) body: z.infer<typeof verifyOperatorSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<{ operator: OperatorResponse }> {
    const operator = await this.catalog.verifyOperator(parseId(id, 'operator'), body, actor.userId);
    return { operator: toOperatorResponse(operator) };
  }

  /**
   * Справочник операторов.
   *
   * Клиенту он нужен, чтобы выбрать разрешённых операторов канала (ADR-0025), партнёру —
   * чтобы объявить оператора своей SIM. Ограничений ADR-0014 это не нарушает: оператор
   * связи не партнёр, и связь «оператор → партнёр» наружу не выходит.
   *
   * Обоим отдаётся **сокращённый** вид: ИНН, MNC и связи MVNO не нужны ни для выбора,
   * ни для заявления. Партнёру — все записи, а не только подтверждённые: резолвер может
   * назвать обслуживающим оператора из импорта плана нумерации, и SIM такого оператора
   * иначе было бы не завести. Справочник был закрыт партнёру, пока SIM заводил только
   * администратор, — и стал дефектом, когда партнёр начал заводить их сам.
   */
  @Roles('admin', 'support')
  @Cabinets('client', 'partner')
  @Get('operators')
  async list(
    @CurrentUser() actor: Principal,
  ): Promise<{ operators: OperatorResponse[] | OperatorChoice[] }> {
    const operators = await this.catalog.listOperators();
    if (!isStaffRole(actor.role)) {
      return { operators: operators.map((operator) => ({ id: operator.id, name: operator.name })) };
    }
    return { operators: operators.map(toOperatorResponse) };
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
    return toResolutionResponse(await this.resolver.resolve(parseMsisdn(msisdn)));
  }

  /**
   * Администратор подтверждает оператора номера вручную
   * ([ADR-0053](../../../../../docs/adr/0053-liniya-goip-po-prefiksu.md)): когда внешний
   * источник недоступен, а номер проверен иначе — например, звонком с него.
   * Ответ — то же определение, что у `GET`, уже подтверждённое.
   */
  @Roles('admin')
  @Put('numbers/:msisdn/operator')
  async confirmOperator(
    @Param('msisdn') msisdn: string,
    @Body(zodBody(confirmNumberOperatorSchema)) body: z.infer<typeof confirmNumberOperatorSchema>,
    @CurrentUser() actor: Principal,
  ): Promise<ResolutionResponse> {
    return toResolutionResponse(
      await this.catalog.confirmNumberOperator(
        parseMsisdn(msisdn),
        parseId(body.operatorId, 'operator'),
        actor,
      ),
    );
  }

  /**
   * Отмена записи об операторе по номеру — действие администратора.
   *
   * Партнёр сообщает о том же иначе: `POST /calls/:id/wrong-network`, по своему вызову
   * ([docs/api/operators.md](../../../../../docs/api/operators.md)). Разница не в удобстве:
   * отмена по произвольному номеру позволяла бы гнать чужие номера на повторное
   * определение, а внешний источник держит два запроса в секунду на всю платформу.
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

function toOperatorResponse(view: OperatorView): OperatorResponse {
  return {
    id: view.id,
    name: view.name,
    inn: view.inn,
    mnc: view.mnc,
    is_mvno: view.isMvno,
    host_operator_id: view.hostOperatorId,
    verified_at: view.verifiedAt?.toISOString() ?? null,
    aliases: view.aliases,
  };
}

function toBlockedView(row: BlockedNumberRow): BlockedNumberView {
  return {
    id: row.id,
    prefix: row.prefix,
    note: row.note,
    created_at: row.createdAt.toISOString(),
  };
}

function toResolutionResponse(resolution: OperatorResolution): ResolutionResponse {
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
