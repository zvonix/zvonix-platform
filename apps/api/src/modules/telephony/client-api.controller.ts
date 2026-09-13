/**
 * Вызовы клиента в **машинном контуре** — `/v1`
 * ([ADR-0044](../../../../../docs/adr/0044-klientskiy-api.md)).
 *
 * Отличается от кабинетного `/client/*` двумя вещами и только ими: клиент берётся
 * из ключа, а не из сессии, и контракт версионирован — в пределах `/v1` поле может
 * появиться, но не исчезнуть и не поменять смысл. Чужая диспетчерская обновляется тогда,
 * когда её владелец сочтёт нужным, и молчаливое изменение ответа означает остановку
 * звонков у клиента.
 *
 * Представления общие с кабинетом (`client-views.ts`): правило приватности одно
 * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)), и второе
 * его описание разошлось бы с первым молча.
 *
 * Инициации вызова здесь нет намеренно: она требует нового пути в media plane
 * (`originate` через ESL), и это отдельное решение, а не часть контура доступа.
 */

import { Controller, Get, Param, Query } from '@nestjs/common';
import { notFound, parseId, type Id } from '@zvonix/shared';
import type { z } from 'zod';
import { Machine } from '../../http/auth.guard.js';
import { CurrentMachine } from '../../http/request-context.js';
import { zodQuery } from '../../http/zod.pipe.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import { CallsService } from './calls.service.js';
import { toClientCallView, type ClientCallView } from './client-views.js';
import { clientCallsQuerySchema } from './schemas.js';

@Controller('v1')
export class ClientApiCallsController {
  constructor(private readonly calls: CallsService) {}

  /**
   * Вызовы клиента: за что списали и почему не звонит.
   *
   * До появления вебхуков это и есть способ узнать о завершении вызова, поэтому предел
   * частоты в этом контуре считает и чтения (ADR-0044).
   */
  @Machine('client_api')
  @Get('calls')
  async list(
    @CurrentMachine() machine: MachinePrincipal,
    @Query(zodQuery(clientCallsQuerySchema)) query: z.infer<typeof clientCallsQuerySchema>,
  ): Promise<{ calls: ClientCallView[]; total: number }> {
    const found = await this.calls.list({
      clientId: clientOf(machine),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.channelId === undefined ? {} : { channelId: parseId(query.channelId, 'channel') }),
      ...(query.destination === undefined ? {} : { destination: query.destination }),
      ...(query.from === undefined ? {} : { from: new Date(query.from) }),
      ...(query.to === undefined ? {} : { to: new Date(query.to) }),
      limit: query.limit,
      offset: query.offset,
    });

    return { total: found.total, calls: found.rows.map(toClientCallView) };
  }

  /**
   * Один вызов.
   *
   * Чужой отвечает `404`, а не `403`, и это здесь не только про приватность: отбор идёт
   * вместе с клиентом из ключа, поэтому чужой вызов не находится — не «находится
   * и скрывается».
   */
  @Machine('client_api')
  @Get('calls/:id')
  async one(
    @Param('id') id: string,
    @CurrentMachine() machine: MachinePrincipal,
  ): Promise<{ call: ClientCallView }> {
    const found = await this.calls.list({
      clientId: clientOf(machine),
      callId: parseId(id, 'call'),
      limit: 1,
      offset: 0,
    });

    const row = found.rows[0];
    if (row === undefined) throw notFound('Вызов не найден');
    return { call: toClientCallView(row) };
  }
}

/**
 * Клиент, которому принадлежит ключ.
 *
 * `ownerId` у ключа вида `client_api` — это идентификатор клиента: вид проверен
 * защитником, и другого владельца у такого ключа не бывает.
 */
function clientOf(machine: MachinePrincipal): Id<'client'> {
  return parseId(machine.ownerId, 'client');
}
