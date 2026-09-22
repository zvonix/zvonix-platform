/**
 * Доменные лимиты клиента, канала, партнёра и SIM
 * ([ADR-0026](../../../../../docs/adr/0026-limity-po-oknam.md)).
 *
 * Это в первую очередь **защита SIM партнёра**: оператор блокирует SIM за нечеловеческий
 * профиль трафика, а потерянная SIM означает потерянного партнёра (BACKLOG.md).
 * Ограничение клиента — следствие, а не цель.
 *
 * Не путать с `RateLimitService`: там защита от перебора паролей — короткое окно,
 * высокая частота, счётчик в Redis, потеря допустима. Здесь квота, потеря которой
 * означает снятую защиту, поэтому счётчик в PostgreSQL и растёт той же транзакцией,
 * что создаёт вызов.
 */

import { Injectable } from '@nestjs/common';
import {
  amountFor,
  bucketStart,
  limitInStoredUnits,
  notFound,
  validationFailed,
  type Id,
  type LimitMetric,
  type LimitWindow,
  type UserRole,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import {
  LimitRepository,
  type CounterKey,
  type Executor,
  type LimitRuleId,
  type LimitRuleRow,
  type LimitSubjects,
} from './limit.repository.js';

/** Правило вместе с израсходованным за его текущее окно. */
export interface LimitUsage {
  readonly rule: LimitRuleRow;
  readonly bucketStart: Date;
  /** В единицах хранения: звонки — штуками, минуты — секундами. */
  readonly used: number;
  readonly limit: number;
  readonly exceeded: boolean;
}

/** Кого именно остановил лимит. Наружу уходит идентификатор правила, а не догадка. */
export class LimitBreach extends Error {
  override readonly name = 'LimitBreach';

  constructor(readonly rule: LimitRuleRow) {
    super(`Превышен лимит ${rule.metric} за ${rule.window}`);
  }
}

/**
 * Сколько дней хранятся счётчики закрытых окон.
 *
 * Квоте они уже не нужны — только разбору «сколько было израсходовано тогда».
 * Квартала достаточно, а дальше это строки, которые никто не читает.
 */
export const COUNTER_RETENTION_DAYS = 92;

@Injectable()
export class LimitService {
  constructor(
    private readonly repository: LimitRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Лимиты субъектов вместе с израсходованным.
   *
   * Два запроса: правила и счётчики их текущих окон. Когда правил нет — ни одного:
   * у большинства установок лимитов не заведено вовсе, и горячий путь не должен
   * платить за пустую настройку.
   */
  /**
   * Убирает счётчики закрытых окон.
   *
   * Догоняюще по сроку, а не «с прошлого запуска» (ADR-0020): проход отбирает окна,
   * начавшиеся раньше отметки, поэтому пропущенный тик ничего не теряет.
   *
   * Срок хранения — не про квоты, а про разбор: по закрытым окнам отвечают на вопрос
   * «сколько было израсходовано в тот день», и держать их дольше квартала незачем.
   */
  async purgeClosedWindows(now: Date): Promise<number> {
    const before = new Date(now.getTime() - COUNTER_RETENTION_DAYS * 86_400_000);
    return this.repository.deleteCountersBefore(before);
  }

  /** Только правила, без счётчиков: тому, кто собирается их увеличивать, счёт не нужен. */
  async rules(subjects: LimitSubjects): Promise<LimitRuleRow[]> {
    return this.repository.listRules(subjects);
  }

  async usage(subjects: LimitSubjects, at: Date): Promise<LimitUsage[]> {
    return this.withUsage(await this.repository.listRules(subjects), at);
  }

  /**
   * Увеличивает счётчики и **проверяет их заново** — в переданной транзакции.
   *
   * Проверка до транзакции — быстрый путь и внятная причина; эта — гарантия: две
   * одновременные заявки иначе обе прочитают «осталось одно» и обе пройдут.
   * Нарушение бросает `LimitBreach`, и транзакция откатывается целиком: вызова
   * не будет, счётчика тоже.
   */
  async consume(
    rules: readonly LimitRuleRow[],
    metric: LimitMetric,
    seconds: number,
    at: Date,
    executor: Executor,
    options: { verify: boolean },
  ): Promise<void> {
    const applicable = rules.filter((rule) => rule.metric === metric);
    if (applicable.length === 0) return;

    const delta = amountFor(metric, seconds);
    const updated = await this.repository.increase(
      applicable.map((rule) => ({
        key: { ruleId: rule.id, bucketStart: bucketStart(rule.window, at) },
        delta,
      })),
      executor,
    );

    if (!options.verify) return;

    for (const rule of applicable) {
      const amount = updated.get(rule.id);
      if (amount === undefined) continue;
      if (amount > limitInStoredUnits(rule.metric, rule.value)) {
        throw new LimitBreach(rule);
      }
    }
  }

  // --- Ведение лимитов ------------------------------------------------------------

  async add(
    input: {
      clientId: Id<'client'> | null;
      channelId: Id<'channel'> | null;
      partnerId: Id<'partner'> | null;
      simCardId: Id<'simCard'> | null;
      window: LimitWindow;
      metric: LimitMetric;
      value: number;
    },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<LimitRuleRow> {
    const named = [input.clientId, input.channelId, input.partnerId, input.simCardId].filter(
      (value) => value !== null,
    );
    // То же ограничение стоит в базе. Здесь — ради внятного сообщения: лимит без субъекта
    // не относится ни к кому, а лимит на двоих сразу непонятно кого ограничивает.
    if (named.length !== 1) {
      throw validationFailed('Лимит задаётся ровно одному: клиенту, каналу, партнёру или SIM');
    }

    const row = await this.repository.insertRule(input);
    await this.audit.record({
      action: 'limit.added',
      entityType: 'limit_rule',
      entityId: row.id,
      actorUserId,
      actorRole,
      after: subjectOf(row),
    });
    return row;
  }

  /**
   * Меняет предел, не трогая израсходованное.
   *
   * Квота изменилась — потраченное никуда не делось. Чтобы обнулить счёт, лимит
   * удаляют: счётчики уходят вместе с правилом.
   */
  async changeValue(
    id: LimitRuleId,
    value: number,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<LimitRuleRow> {
    const before = await this.repository.findRule(id);
    if (before === undefined) throw notFound('Лимит не найден');

    const row = await this.repository.updateValue(id, value);
    if (row === undefined) throw notFound('Лимит не найден');

    await this.audit.record({
      action: 'limit.changed',
      entityType: 'limit_rule',
      entityId: id,
      actorUserId,
      actorRole,
      before: { value: before.value },
      after: { value: row.value },
    });
    return row;
  }

  async remove(
    id: LimitRuleId,
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<LimitRuleRow> {
    const removed = await this.repository.deleteRule(id);
    if (removed === undefined) throw notFound('Лимит не найден');

    await this.audit.record({
      action: 'limit.removed',
      entityType: 'limit_rule',
      entityId: id,
      actorUserId,
      actorRole,
      before: { ...subjectOf(removed), value: removed.value },
    });
    return removed;
  }

  /** Лимиты субъекта вместе с израсходованным — для разбора «почему не звонит». */
  async list(subject: LimitSubjects, at: Date): Promise<LimitUsage[]> {
    return this.withUsage(await this.repository.listRulesOf(subject), at);
  }

  /**
   * Дополняет правила израсходованным за их текущие окна.
   *
   * Одно место на всех: горячий путь и разбор обязаны считать окно **одинаково**,
   * иначе поддержка увидит не то, что видела маршрутизация.
   */
  private async withUsage(rules: readonly LimitRuleRow[], at: Date): Promise<LimitUsage[]> {
    if (rules.length === 0) return [];

    const keys: CounterKey[] = rules.map((rule) => ({
      ruleId: rule.id,
      bucketStart: bucketStart(rule.window, at),
    }));
    const used = await this.repository.listUsage(keys);

    return rules.map((rule, index) => {
      const amount = used.get(rule.id) ?? 0;
      const limit = limitInStoredUnits(rule.metric, rule.value);
      return {
        rule,
        bucketStart: keys[index]?.bucketStart ?? bucketStart(rule.window, at),
        used: amount,
        limit,
        exceeded: amount >= limit,
      };
    });
  }
}

function subjectOf(row: LimitRuleRow): Record<string, unknown> {
  return {
    client_id: row.clientId,
    channel_id: row.channelId,
    partner_id: row.partnerId,
    sim_card_id: row.simCardId,
    window: row.window,
    metric: row.metric,
    value: row.value,
  };
}
