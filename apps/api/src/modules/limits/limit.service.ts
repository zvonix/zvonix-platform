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
  bucketEnd,
  bucketStart,
  limitInStoredUnits,
  notFound,
  permissionDenied,
  validationFailed,
  type Id,
  type LimitMetric,
  type LimitRounding,
  type LimitSetBy,
  type LimitWindow,
  type UserRole,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import {
  counterKeyOf,
  LimitRepository,
  type Executor,
  type LimitRuleId,
  type LimitRuleRow,
  type LimitSubjects,
} from './limit.repository.js';

/**
 * Правило вместе с израсходованным за его текущее окно. У правила «на каждую карту»
 * (ADR-0057) таких строк по одной на SIM, `simCardId` называет её.
 */
export interface LimitUsage {
  readonly rule: LimitRuleRow;
  readonly simCardId: Id<'simCard'> | null;
  readonly bucketStart: Date;
  /** Когда окно закончится и счётчик обнулится. */
  readonly resetsAt: Date;
  /** В единицах хранения: звонки — штуками, минуты — секундами. */
  readonly used: number;
  readonly limit: number;
  readonly exceeded: boolean;
}

/** SIM партнёра — для правил «на каждую карту»: чьи счётчики показать и проверить. */
export interface PartnerSim {
  readonly partnerId: Id<'partner'>;
  readonly simCardId: Id<'simCard'>;
  /** Тариф, по которому карта работает (SIM → шлюз → по умолчанию); по нему действуют лимиты тарифа. */
  readonly tariffId?: Id<'partnerTariff'> | null;
}

/** Кто меняет правило: для журнала и для проверки «партнёр — только свои». */
interface Actor {
  readonly userId: Id<'user'>;
  readonly role: UserRole;
}

/** Кого именно остановил лимит. Наружу уходит идентификатор правила, а не догадка. */
export class LimitBreach extends Error {
  override readonly name = 'LimitBreach';

  constructor(readonly rule: LimitRuleRow) {
    super(`Превышен лимит ${rule.metric} за ${rule.window}`);
  }
}

/** Сколько хранятся счётчики минутных и часовых окон: они нужны только сейчас. */
const SHORT_COUNTER_RETENTION_DAYS = 2;

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
    const shortBefore = new Date(now.getTime() - SHORT_COUNTER_RETENTION_DAYS * 86_400_000);
    return this.repository.deleteCountersBefore(before, shortBefore);
  }

  /** Только правила, без счётчиков: тому, кто собирается их увеличивать, счёт не нужен. */
  async rules(subjects: LimitSubjects): Promise<LimitRuleRow[]> {
    return this.repository.listRules(subjects);
  }

  /**
   * Лимиты субъектов с израсходованным. `sims` — карты, по которым показать правила
   * «на каждую карту»: у отбора кандидатов это кандидаты, у кабинета — карты партнёра.
   */
  async usage(
    subjects: LimitSubjects,
    at: Date,
    sims: readonly PartnerSim[] = [],
  ): Promise<LimitUsage[]> {
    return this.withUsage(await this.repository.listRules(subjects), at, sims);
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
    call: {
      readonly seconds: number;
      /** SIM вызова: по ней считаются правила «на каждую карту». У транка — пусто. */
      readonly simCardId: Id<'simCard'> | null;
    },
    at: Date,
    executor: Executor,
    options: { verify: boolean },
  ): Promise<void> {
    // Правило «на каждую карту» без карты не считается: у транка SIM нет.
    const applicable = rules.filter(
      (rule) => rule.metric === metric && (!rule.perSim || call.simCardId !== null),
    );
    if (applicable.length === 0) return;

    const updated = await this.repository.increase(
      applicable.map((rule) => ({
        key: {
          ruleId: rule.id,
          simCardId: rule.perSim ? call.simCardId : null,
          bucketStart: bucketStart(rule.window, at, rule.periodStartDay),
        },
        // Поминутный счёт округляет каждый разговор до минуты — у каждого правила свой.
        delta: amountFor(metric, call.seconds, rule.rounding),
      })),
      executor,
    );

    if (!options.verify) return;

    for (const rule of applicable) {
      const amount = updated.get(counterKeyOf(rule.id, rule.perSim ? call.simCardId : null));
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
      /** Лимит в тарифе партнёра; действует на каждую карту тарифа (ADR-0080). */
      tariffId?: Id<'partnerTariff'> | null;
      window: LimitWindow;
      metric: LimitMetric;
      value: number;
      perSim?: boolean;
      rounding?: LimitRounding;
      periodStartDay?: number | null;
      setBy?: LimitSetBy;
    },
    actorUserId: Id<'user'>,
    actorRole: UserRole,
  ): Promise<LimitRuleRow> {
    const named = [
      input.clientId,
      input.channelId,
      input.partnerId,
      input.simCardId,
      input.tariffId ?? null,
    ].filter((value) => value !== null);
    // То же ограничение стоит в базе. Здесь — ради внятного сообщения: лимит без субъекта
    // не относится ни к кому, а лимит на двоих сразу непонятно кого ограничивает.
    if (named.length !== 1) {
      throw validationFailed(
        'Лимит задаётся ровно одному: клиенту, каналу, партнёру, SIM или тарифу',
      );
    }
    const draft = {
      ...input,
      tariffId: input.tariffId ?? null,
      // У лимита тарифа общего счётчика нет: он считается у каждой карты (ADR-0080).
      perSim: input.tariffId == null ? (input.perSim ?? false) : true,
      rounding: input.rounding ?? 'second',
      periodStartDay: input.periodStartDay ?? null,
      setBy: input.setBy ?? 'platform',
    } as const;
    assertShape(draft);

    const row = await this.repository.insertRule(draft);
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
   * Меняет предел (и у минут — счёт, у месяца — день обновления), не трогая
   * израсходованное. Квота изменилась — потраченное никуда не делось. Чтобы обнулить
   * счёт, лимит удаляют: счётчики уходят вместе с правилом.
   *
   * `owner` — партнёр, меняющий своё: чужое правило и правило площадки ему не видны
   * как изменяемые (ADR-0057). Администратор меняет любое.
   */
  async changeRule(
    id: LimitRuleId,
    change: {
      value: number;
      rounding?: LimitRounding | undefined;
      periodStartDay?: number | null | undefined;
    },
    actor: Actor,
    owner?: (rule: LimitRuleRow) => boolean,
  ): Promise<LimitRuleRow> {
    const before = await this.requireRule(id, owner);
    assertShape({
      ...before,
      rounding: change.rounding ?? before.rounding,
      periodStartDay:
        change.periodStartDay === undefined ? before.periodStartDay : change.periodStartDay,
    });

    const row = await this.repository.updateRule(id, change);
    if (row === undefined) throw notFound('Лимит не найден');

    await this.audit.record({
      action: 'limit.changed',
      entityType: 'limit_rule',
      entityId: id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: subjectOf(before),
      after: subjectOf(row),
    });
    return row;
  }

  async remove(
    id: LimitRuleId,
    actor: Actor,
    owner?: (rule: LimitRuleRow) => boolean,
  ): Promise<LimitRuleRow> {
    await this.requireRule(id, owner);
    const removed = await this.repository.deleteRule(id);
    if (removed === undefined) throw notFound('Лимит не найден');

    await this.audit.record({
      action: 'limit.removed',
      entityType: 'limit_rule',
      entityId: id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: subjectOf(removed),
    });
    return removed;
  }

  /** Правило — или отказ; партнёру — только своё и заданное им самим. */
  private async requireRule(
    id: LimitRuleId,
    owner: ((rule: LimitRuleRow) => boolean) | undefined,
  ): Promise<LimitRuleRow> {
    const rule = await this.repository.findRule(id);
    if (rule === undefined || (owner !== undefined && !owner(rule))) {
      throw notFound('Лимит не найден');
    }
    if (owner !== undefined && rule.setBy !== 'partner') {
      throw permissionDenied('Этот лимит задала площадка — изменить его может только она');
    }
    return rule;
  }

  /** Лимиты субъекта вместе с израсходованным — для разбора «почему не звонит». */
  async list(subject: LimitSubjects, at: Date): Promise<LimitUsage[]> {
    return this.withUsage(await this.repository.listRulesOf(subject), at, []);
  }

  /**
   * Дополняет правила израсходованным за их текущие окна.
   *
   * Одно место на всех: горячий путь и разбор обязаны считать окно **одинаково**,
   * иначе поддержка увидит не то, что видела маршрутизация.
   */
  private async withUsage(
    rules: readonly LimitRuleRow[],
    at: Date,
    sims: readonly PartnerSim[],
  ): Promise<LimitUsage[]> {
    if (rules.length === 0) return [];

    const windowOf = (rule: LimitRuleRow) => ({
      bucketStart: bucketStart(rule.window, at, rule.periodStartDay),
      resetsAt: bucketEnd(rule.window, at, rule.periodStartDay),
    });
    const counters = await this.repository.listUsage(
      rules.map((rule) => ({ ruleId: rule.id, bucketStart: windowOf(rule).bucketStart })),
    );
    const used = new Map(
      counters.map((row) => [counterKeyOf(row.ruleId, row.simCardId), row.amount]),
    );

    return rules.flatMap((rule) => {
      const window = windowOf(rule);
      const limit = limitInStoredUnits(rule.metric, rule.value);
      const entry = (simCardId: Id<'simCard'> | null): LimitUsage => {
        const amount = used.get(counterKeyOf(rule.id, simCardId)) ?? 0;
        return { rule, simCardId, ...window, used: amount, limit, exceeded: amount >= limit };
      };
      if (!rule.perSim) return [entry(null)];
      // «На каждую карту»: названные карты партнёра — все, даже без счётчика; прочие
      // — те, у кого счётчик в окне уже есть (разбор у администратора).
      // Правило тарифа — карты, работающие по этому тарифу.
      const named = sims
        .filter((sim) =>
          rule.tariffId === null
            ? sim.partnerId === rule.partnerId
            : sim.tariffId === rule.tariffId,
        )
        .map((sim) => sim.simCardId);
      const counted = counters
        .filter((row) => row.ruleId === rule.id && row.simCardId !== null)
        .map((row) => row.simCardId as Id<'simCard'>);
      return [...new Set([...named, ...counted])].map(entry);
    });
  }
}

/**
 * Согласованность полей правила — то же держат ограничения базы, здесь ради внятного
 * отказа: «на каждую карту» — только у партнёра, счёт минут — только у минут, день
 * обновления — только у месяца.
 */
function assertShape(rule: {
  partnerId: Id<'partner'> | null;
  tariffId: Id<'partnerTariff'> | null;
  window: LimitWindow;
  metric: LimitMetric;
  perSim: boolean;
  rounding: LimitRounding;
  periodStartDay: number | null;
}): void {
  if (rule.perSim && rule.partnerId === null && rule.tariffId === null) {
    throw validationFailed('«На каждую карту» задаётся только партнёру или его тарифу');
  }
  if (rule.rounding !== 'second' && rule.metric !== 'minutes') {
    throw validationFailed('Поминутный счёт бывает только у минут');
  }
  if (rule.periodStartDay !== null && rule.window !== 'month') {
    throw validationFailed('День обновления задаётся только месячному окну');
  }
}

function subjectOf(row: LimitRuleRow): Record<string, unknown> {
  return {
    client_id: row.clientId,
    channel_id: row.channelId,
    partner_id: row.partnerId,
    sim_card_id: row.simCardId,
    tariff_id: row.tariffId,
    window: row.window,
    metric: row.metric,
    value: row.value,
    per_sim: row.perSim,
    rounding: row.rounding,
    period_start_day: row.periodStartDay,
    set_by: row.setBy,
  };
}
