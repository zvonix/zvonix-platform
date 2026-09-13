/**
 * Разбор вызовов: что происходило и почему не звонило.
 *
 * Вызовы пишутся с первого дня, включая несостоявшиеся с названной причиной, — но
 * прочитать их можно было только по одному каналу, зная его идентификатор. Вопрос,
 * с которого начинается любое обращение в поддержку («у нас не звонит»), так
 * не отвечался вовсе: искать канал было не от чего.
 *
 * Служба доклеивает к вызову его окружение — чей это клиент, какой оператор, через
 * какого партнёра ушёл. Все три названия принадлежат чужим модулям и берутся через
 * их публичные входы, пачкой на страницу (ARCHITECTURE.md, «Границы модулей»).
 */

import { Injectable } from '@nestjs/common';
import { CALL_STATUSES, type CallFailureReason, type CallStatus, type Id } from '@zvonix/shared';
import { BillingService } from '../billing/billing.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import {
  CallRepository,
  type CallFilter,
  type CallRow,
  type CallSummaryFilter,
} from './call.repository.js';

/** Вызов вместе со всем, что нужно, чтобы понять его, не открывая соседних разделов. */
export interface CallDetails {
  readonly call: CallRow;
  readonly clientId: Id<'client'>;
  /** Прочерк вместо пустоты, если клиента успели удалить: строка вызова переживает его. */
  readonly clientName: string;
  readonly channelName: string;
  readonly operatorName: string | null;
  readonly partnerId: Id<'partner'> | null;
  /**
   * Настоящее имя партнёра. Административный контур
   * ([ADR-0014](../../../../../docs/adr/0014-vybor-partnera-klientom.md)):
   * этот разбор доступен только администратору и поддержке.
   */
  readonly partnerName: string | null;
  readonly partnerAlias: string | null;
  readonly gatewayName: string | null;
  readonly simMsisdn: string | null;
}

/**
 * Чем закончились вызовы за период.
 *
 * Причины идут по убыванию частоты, а не в порядке объявления: разбор начинают
 * с самой частой, и порядок «как в перечислении» заставлял бы её искать глазами.
 */
export interface CallSummary {
  readonly total: number;
  readonly byStatus: readonly { status: CallStatus; count: number }[];
  readonly byReason: readonly { reason: CallFailureReason; count: number }[];
}

@Injectable()
export class CallsService {
  constructor(
    private readonly calls: CallRepository,
    private readonly billing: BillingService,
    private readonly catalog: CatalogService,
  ) {}

  async list(filter: CallFilter): Promise<{ rows: CallDetails[]; total: number }> {
    const found = await this.calls.list(filter);
    if (found.rows.length === 0) return { rows: [], total: found.total };

    const clientIds = unique(found.rows.map((row) => row.clientId));
    const partnerIds = unique(found.rows.map((row) => row.partnerId));
    const operatorIds = unique(found.rows.map((row) => row.call.operatorId));

    // Три запроса на страницу вместо трёх на строку. Параллельно: они независимы,
    // и последовательное ожидание втрое удлинило бы ответ безо всякой причины.
    const [clients, partners, operators] = await Promise.all([
      this.billing.clientNamesOf(clientIds),
      this.billing.partnerNamesOf(partnerIds),
      this.catalog.operatorNamesOf(operatorIds),
    ]);

    return {
      total: found.total,
      rows: found.rows.map((row) => {
        const partner = row.partnerId === null ? undefined : partners.get(row.partnerId);
        return {
          call: row.call,
          clientId: row.clientId,
          clientName: clients.get(row.clientId) ?? 'запись удалена',
          channelName: row.channelName,
          operatorName:
            row.call.operatorId === null ? null : (operators.get(row.call.operatorId) ?? null),
          partnerId: row.partnerId,
          partnerName: partner?.name ?? null,
          partnerAlias: partner?.displayName ?? null,
          gatewayName: row.gatewayName,
          simMsisdn: row.simMsisdn,
        };
      }),
    };
  }

  async summary(filter: CallSummaryFilter): Promise<CallSummary> {
    const tallies = await this.calls.summary(filter);

    const statuses = new Map<CallStatus, number>();
    const reasons = new Map<CallFailureReason, number>();
    let total = 0;

    for (const tally of tallies) {
      total += tally.count;
      statuses.set(tally.status, (statuses.get(tally.status) ?? 0) + tally.count);
      if (tally.failureReason !== null) {
        reasons.set(tally.failureReason, (reasons.get(tally.failureReason) ?? 0) + tally.count);
      }
    }

    return {
      total,
      // Состояния — в порядке объявления: это шкала от «идёт» до «не состоялся»,
      // и переставлять её по частоте значило бы каждый раз читать заново.
      byStatus: CALL_STATUSES.filter((status) => statuses.has(status)).map((status) => ({
        status,
        count: statuses.get(status) ?? 0,
      })),
      byReason: [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count),
    };
  }
}

/** Непустые значения без повторов: по ним спрашиваются названия. */
function unique<T extends string>(values: readonly (T | null)[]): T[] {
  return [...new Set(values.filter((value): value is T => value !== null))];
}
