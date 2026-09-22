/**
 * Чтение вызовов — разбор «почему не звонит» и «за что списали».
 *
 * До этих обработчиков вызовы читались только по одному каналу, и то при известном
 * идентификаторе канала. Обращение поддержки начинается не с канала, а с жалобы,
 * поэтому отбор идёт по клиенту, партнёру, номеру, периоду и причине отказа.
 *
 * **Только чтение.** Вызов заводит узел, а меняет его CDR; правки вызова из API нет.
 */

import { Controller, Get, Param, Query } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { boundedLimit } from '../../http/pagination.js';
import { CallsService, type CallDetails } from './calls.service.js';
import { callsQuerySchema, callsSummaryQuerySchema } from './schemas.js';
import { zodQuery } from '../../http/zod.pipe.js';

/**
 * Вызов по проводу.
 *
 * Номер назначения — персональные данные абонента, и здесь он полный: обработчик
 * доступен только администратору и поддержке. Настоящее имя партнёра — по той же
 * причине ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)):
 * запрет действует на клиентский контур, а не на разбор обращения.
 */
interface CallView {
  readonly id: string;
  readonly external_id: string;
  readonly destination: string;
  readonly status: string;
  readonly failure_reason: string | null;
  readonly duration_seconds: number | null;
  readonly started_at: string;
  readonly answered_at: string | null;
  readonly ended_at: string | null;
  readonly region: string | null;
  readonly client: { id: string; name: string };
  readonly channel: { id: string; name: string };
  readonly operator: { id: string; name: string } | null;
  /** Пусто у отказа: до выбора железа дело не дошло. */
  readonly partner: { id: string; name: string; display_name: string | null } | null;
  readonly gateway: { id: string; name: string } | null;
  readonly sim: { id: string; msisdn: string } | null;
}

interface SummaryView {
  readonly total: number;
  readonly by_status: readonly { status: string; count: number }[];
  readonly by_reason: readonly { reason: string; count: number }[];
}

@Controller()
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  /**
   * Вызовы по отбору, свежие сверху.
   *
   * Поддержке доступен наравне с администратором: разбор обращения — это её работа,
   * и «спросить администратора» здесь означало бы, что поддержки нет.
   */
  @Roles('admin', 'support')
  @Get('calls')
  async list(
    @Query(zodQuery(callsQuerySchema)) query: z.infer<typeof callsQuerySchema>,
  ): Promise<{ calls: CallView[]; total: number }> {
    const found = await this.calls.list({
      ...filterOf(query),
      limit: query.limit,
      offset: query.offset,
    });
    return { total: found.total, calls: found.rows.map(toCallView) };
  }

  /**
   * Чем закончились вызовы за период — ответ на «почему не звонит» одним взглядом.
   *
   * Отдельным обработчиком, а не полем в списке: вопрос задан обо всём периоде,
   * а список показывает страницу. Считать сводку по выданной странице значило бы
   * отвечать про полсотни вызовов там, где спросили про сутки.
   */
  @Roles('admin', 'support')
  @Get('calls/summary')
  async summary(
    @Query(zodQuery(callsSummaryQuerySchema)) query: z.infer<typeof callsSummaryQuerySchema>,
  ): Promise<SummaryView> {
    const summary = await this.calls.summary(filterOf(query));
    return {
      total: summary.total,
      by_status: summary.byStatus,
      by_reason: summary.byReason.map((row) => ({ reason: row.reason, count: row.count })),
    };
  }

  /**
   * Вызовы одного канала.
   *
   * Частный случай отбора выше, оставленный отдельным адресом: канал — естественный
   * родитель вызова, и разбор «за что списали» приходит именно от него.
   */
  @Roles('admin', 'support')
  @Get('channels/:id/calls')
  async listByChannel(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ): Promise<{ calls: CallView[] }> {
    const found = await this.calls.list({
      channelId: parseId(id, 'channel'),
      limit: boundedLimit(limit),
      offset: 0,
    });
    return { calls: found.rows.map(toCallView) };
  }
}

/**
 * Отбор из параметров адреса.
 *
 * Поля расписываются поштучно, а не разворачиваются целиком: при
 * `exactOptionalPropertyTypes` присутствующее поле со значением `undefined`
 * и отсутствующее поле — разные вещи, и отбор «любой» должен быть вторым.
 */
function filterOf(query: z.infer<typeof callsSummaryQuerySchema>) {
  return {
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.failureReason === undefined ? {} : { failureReason: query.failureReason }),
    ...(query.clientId === undefined ? {} : { clientId: parseId(query.clientId, 'client') }),
    ...(query.channelId === undefined ? {} : { channelId: parseId(query.channelId, 'channel') }),
    ...(query.partnerId === undefined ? {} : { partnerId: parseId(query.partnerId, 'partner') }),
    ...(query.destination === undefined ? {} : { destination: query.destination }),
    ...(query.from === undefined ? {} : { from: new Date(query.from) }),
    ...(query.to === undefined ? {} : { to: new Date(query.to) }),
  };
}

function toCallView(row: CallDetails): CallView {
  const call = row.call;
  return {
    id: call.id,
    external_id: call.externalId,
    destination: call.destination,
    status: call.status,
    failure_reason: call.failureReason,
    duration_seconds: call.durationSeconds,
    started_at: call.startedAt.toISOString(),
    answered_at: call.answeredAt?.toISOString() ?? null,
    ended_at: call.endedAt?.toISOString() ?? null,
    region: call.region,
    client: { id: row.clientId, name: row.clientName },
    channel: { id: call.channelId, name: row.channelName },
    operator:
      call.operatorId === null || row.operatorName === null
        ? null
        : { id: call.operatorId, name: row.operatorName },
    partner:
      row.partnerId === null || row.partnerName === null
        ? null
        : { id: row.partnerId, name: row.partnerName, display_name: row.partnerAlias },
    gateway:
      call.gatewayId === null || row.gatewayName === null
        ? null
        : { id: call.gatewayId, name: row.gatewayName },
    sim:
      call.simCardId === null || row.simMsisdn === null
        ? null
        : { id: call.simCardId, msisdn: row.simMsisdn },
  };
}
