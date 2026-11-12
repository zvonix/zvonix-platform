/**
 * Прогрев и рекомендованная работа номера — SIM или SIP-транка
 * ([ADR-0105](../../../../../docs/adr/0105-progrev-i-rekomendovannaya-rabota-nomera.md)).
 *
 * Окна скользящие и считаются по таблице вызовов: вызов и так пишется той же транзакцией, что занимает номер, и
 * отдельный счётчик был бы второй копией того же факта.
 */

import { Injectable } from '@nestjs/common';
import {
  awakeNumbers,
  callPace,
  callRestingUntil,
  callRestWindowMs,
  callWarmupDay,
  isIdleNumber,
  isPoorNumber,
  trunkSpacedUntil,
  withoutRecommendedPace,
  type CallPace,
  type CallPaceSettings,
  type Id,
  variedDailyLimit,
} from '@zvonix/shared';
import { BillingRepository } from '../billing/billing.repository.js';
import { SettingsService } from '../settings/settings.service.js';
import { CallRepository, type Executor, type NumberAttempts } from './call.repository.js';
import { QualityService } from './quality.service.js';
import {
  TelephonyRepository,
  type GatewayRow,
  type SimCardRow,
  type SipTrunkRow,
  type TerminationCandidate,
} from './telephony.repository.js';

/** Номер, каким его видит предел: карта или транк. */
export interface PacedNumber {
  readonly kind: 'sim' | 'sip';
  /** SIM — её идентификатор, транк — идентификатор шлюза. */
  readonly id: string;
  readonly warmupStartedAt: Date | null;
  /** Номеров у транка; у SIM — один. */
  readonly numbers: number;
  /** Оператор SIM — по нему автоторможение (ADR-0108); у транка оператора нет. */
  readonly operatorId: string | null;
  /** Чей номер: партнёр выбирает, работают ли его номера по рекомендациям площадки (ADR-0117). */
  readonly partnerId: Id<'partner'>;
}

/** Пределы номера и израсходованное за скользящие час и сутки. */
export interface NumberPace extends CallPace {
  readonly usedHour: number;
  readonly usedDay: number;
  /** Разных абонентов за час и сутки (ADR-0106). */
  readonly distinctUsedHour: number;
  readonly distinctUsedDay: number;
  /** Звонил ли номер спрошенному абоненту за час и сутки: перезвон знакомому нового абонента не добавляет. */
  readonly calledHour: boolean;
  readonly calledDay: boolean;
  /** До какого времени номер отдыхает после прошлых вызовов; `null` — свободен. */
  readonly restingUntil: Date | null;
  /** Без попыток за 14 суток: этот вызов начнёт прогрев (ADR-0105). */
  readonly idle: boolean;
  /** Сон номера (ADR-0107): до какого времени спит; `null` — не спит. */
  readonly asleepUntil: Date | null;
  readonly realAnsweredDay: number;
}

const NO_ATTEMPTS: NumberAttempts = {
  hour: 0,
  day: 0,
  distinctHour: 0,
  distinctDay: 0,
  realAnsweredDay: 0,
  calledHour: false,
  calledDay: false,
  lastAt: null,
  ended: [],
};

/** Итог отбора: номера, которым сейчас звонить нельзя, и номера, уже звонившие этому абоненту за сутки. */
export interface PaceScreen {
  readonly exhausted: ReadonlySet<string>;
  readonly calledBefore: ReadonlySet<string>;
}

export function pacedSim(sim: SimCardRow): PacedNumber {
  return {
    kind: 'sim',
    id: sim.id,
    warmupStartedAt: sim.warmupStartedAt,
    numbers: 1,
    operatorId: sim.operatorId,
    partnerId: sim.partnerId,
  };
}

export function pacedTrunk(row: { gateway: GatewayRow; trunk: SipTrunkRow }): PacedNumber {
  return {
    kind: 'sip',
    id: row.gateway.id,
    warmupStartedAt: row.trunk.warmupStartedAt,
    numbers: row.trunk.numbersCount,
    operatorId: null,
    partnerId: row.gateway.partnerId,
  };
}

export function pacedNumberOf(candidate: TerminationCandidate): PacedNumber {
  return candidate.kind === 'sim' ? pacedSim(candidate.sim) : pacedTrunk(candidate);
}

/** Пределы номера в ответе кабинету: `null` — без предела. */
export interface NumberPaceView {
  /** Сутки прогрева с единицы; пусто — прогрет или прогрев выключен. */
  readonly warmup_day: number | null;
  readonly per_hour: number | null;
  readonly per_day: number | null;
  readonly used_hour: number;
  readonly used_day: number;
  /** Разных абонентов: предел и израсходованное (ADR-0106). */
  readonly distinct_per_hour: number | null;
  readonly distinct_per_day: number | null;
  readonly distinct_used_hour: number;
  readonly distinct_used_day: number;
  /** Пауза после прошлого вызова: до какого времени номер отдыхает; пусто — свободен. */
  readonly resting_until: string | null;
  /** Сон номера (ADR-0107): до какого времени спит; пусто — не спит. */
  readonly asleep_until: string | null;
  /** «Плохой» номер: мало настоящих ответов, пределы вдвое ниже. */
  readonly poor: boolean;
  /** Оператор номера тормозит (ADR-0108): пределы ниже обычных. */
  readonly braked: boolean;
}

export function toPaceView(pace: NumberPace): NumberPaceView {
  return {
    warmup_day: pace.warmupDay === null ? null : pace.warmupDay + 1,
    per_hour: pace.perHour,
    per_day: pace.perDay,
    used_hour: pace.usedHour,
    used_day: pace.usedDay,
    distinct_per_hour: pace.distinctPerHour,
    distinct_per_day: pace.distinctPerDay,
    distinct_used_hour: pace.distinctUsedHour,
    distinct_used_day: pace.distinctUsedDay,
    resting_until: pace.restingUntil?.toISOString() ?? null,
    asleep_until: pace.asleepUntil?.toISOString() ?? null,
    poor: pace.poor,
    braked: pace.braked,
  };
}

function paceOf(
  recommendedSettings: CallPaceSettings,
  number: PacedNumber,
  attempts: NumberAttempts,
  now: Date,
  recommendedBraked: boolean,
  recommended: boolean,
): NumberPace {
  // Партнёр выключил рекомендации (ADR-0117): только пауза и сон; автоторможение — тоже часть рекомендаций.
  const settings = recommended ? recommendedSettings : withoutRecommendedPace(recommendedSettings);
  const braked = recommended && recommendedBraked;
  const warmupDay = callWarmupDay(number.warmupStartedAt, attempts.lastAt, now);
  const poor = isPoorNumber(attempts.day, attempts.realAnsweredDay, settings.poorAnswerPercent);
  // Сон (ADR-0107, ADR-0108): у каждого номера свои часы, и у транка — у каждого его номера. Сутки считаются на все
  // номера: звонки, сделанные днём, не должны запирать транк ночью. Час, абоненты за час и места паузы — на тех,
  // кто сейчас не спит.
  const sleep = awakeNumbers(number.id, number.numbers, settings.sleepHours, now);
  const full = callPace(settings, warmupDay, number.numbers, poor, braked);
  const awake = callPace(settings, warmupDay, Math.max(1, sleep.awake), poor, braked);
  const pace: CallPace = {
    ...full,
    // Разный предел по дням (ADR-0116): своя доля у номера на каждую дату по Москве.
    perDay:
      full.perDay === null
        ? null
        : variedDailyLimit(full.perDay, number.id, now, settings.dailyVariationPercent),
    perHour: awake.perHour,
    distinctPerHour: awake.distinctPerHour,
    numbers: awake.numbers,
  };
  const resting = callRestingUntil(pace, attempts.ended, now);
  // Ровный шаг SIP-провайдера (ADR-0108): вызовы транка не пачкой.
  const spaced =
    number.kind === 'sip'
      ? trunkSpacedUntil(attempts.lastAt, settings.trunkCallsPerSecond, now)
      : null;
  return {
    ...pace,
    usedHour: attempts.hour,
    usedDay: attempts.day,
    distinctUsedHour: attempts.distinctHour,
    distinctUsedDay: attempts.distinctDay,
    calledHour: attempts.calledHour,
    calledDay: attempts.calledDay,
    restingUntil:
      resting === null ? spaced : spaced === null || spaced < resting ? resting : spaced,
    idle: isIdleNumber(attempts.lastAt, now),
    asleepUntil: sleep.wakesAt,
    realAnsweredDay: attempts.realAnsweredDay,
  };
}

/**
 * Номеру сейчас звонить нельзя: исчерпаны попытки, номер отдыхает после прошлого вызова, спит (ADR-0107) или исчерпал
 * разных абонентов — кроме абонента, которому он уже звонил в этом окне (ADR-0106).
 */
function exhausted(pace: NumberPace): boolean {
  return (
    (pace.perHour !== null && pace.usedHour >= pace.perHour) ||
    (pace.perDay !== null && pace.usedDay >= pace.perDay) ||
    pace.restingUntil !== null ||
    pace.asleepUntil !== null ||
    (pace.distinctPerHour !== null &&
      !pace.calledHour &&
      pace.distinctUsedHour >= pace.distinctPerHour) ||
    (pace.distinctPerDay !== null && !pace.calledDay && pace.distinctUsedDay >= pace.distinctPerDay)
  );
}

@Injectable()
export class CallPaceService {
  constructor(
    private readonly calls: CallRepository,
    private readonly telephony: TelephonyRepository,
    private readonly settings: SettingsService,
    private readonly quality: QualityService,
    private readonly billing: BillingRepository,
  ) {}

  /**
   * Пределы и израсходованное у каждого номера — для отбора кандидатов и для кабинета. `destination` — абонент
   * вызова: звонил ли ему номер (перезвон); у кабинета абонента нет.
   */
  async paces(
    numbers: readonly PacedNumber[],
    now: Date,
    destination?: string,
    executor?: Executor,
  ): Promise<Map<string, NumberPace>> {
    const [settings, braked, own] = await Promise.all([
      this.settings.callPace(),
      this.quality.brakedOperators(now),
      this.ownPacePartners(numbers),
    ]);
    const window = callRestWindowMs(settings);
    const options = {
      destination,
      restSince: window > 0 ? new Date(now.getTime() - window) : undefined,
    };
    const [sims, trunks] = await Promise.all([
      this.calls.numberAttempts(
        'sim',
        numbers.filter((number) => number.kind === 'sim').map((number) => number.id),
        now,
        options,
        executor,
      ),
      this.calls.numberAttempts(
        'gateway',
        numbers.filter((number) => number.kind === 'sip').map((number) => number.id),
        now,
        options,
        executor,
      ),
    ]);
    const result = new Map<string, NumberPace>();
    for (const number of numbers) {
      const attempts = (number.kind === 'sim' ? sims : trunks).get(number.id) ?? NO_ATTEMPTS;
      result.set(
        number.id,
        paceOf(
          settings,
          number,
          attempts,
          now,
          number.operatorId !== null && braked.has(number.operatorId),
          !own.has(number.partnerId),
        ),
      );
    }
    return result;
  }

  /**
   * Партнёры этих номеров, чьи карты работают по своим лимитам (ADR-0117). Пусто, если площадка этого не разрешает:
   * тогда рекомендации действуют у всех, даже у выключивших их раньше.
   */
  private async ownPacePartners(numbers: readonly PacedNumber[]): Promise<ReadonlySet<string>> {
    if (numbers.length === 0 || !(await this.settings.partnerMayDisableCallPace())) {
      return new Set();
    }
    return this.billing.partnersOnOwnCallPace([
      ...new Set(numbers.map((number) => number.partnerId)),
    ]);
  }

  /**
   * Отбор кандидатов вызова абоненту `destination`: какие номера сейчас звонить не могут (SIM — по её идентификатору,
   * транк — по шлюзу) и какие уже звонили этому абоненту за сутки — им перезвон (ADR-0106).
   */
  async screen(
    candidates: readonly TerminationCandidate[],
    now: Date,
    destination: string,
  ): Promise<PaceScreen> {
    const paces = await this.paces(candidates.map(pacedNumberOf), now, destination);
    const out = new Set<string>();
    const called = new Set<string>();
    for (const [id, pace] of paces) {
      if (exhausted(pace)) out.add(id);
      if (pace.calledDay) called.add(id);
    }
    return { exhausted: out, calledBefore: called };
  }

  /**
   * Пускает вызов на номер: в транзакции вызова, **после** блокировки строки SIM или транка — иначе две одновременные
   * заявки насчитали бы одно и то же и прошли обе. Номер, молчавший 14 суток, начинает прогрев этим вызовом.
   */
  async admit(
    candidate: TerminationCandidate,
    destination: string,
    now: Date,
    tx: Executor,
  ): Promise<boolean> {
    const number = pacedNumberOf(candidate);
    const pace = (await this.paces([number], now, destination, tx)).get(number.id);
    if (pace === undefined || exhausted(pace)) return false;
    if (pace.idle) await this.startWarmup(number, now, tx);
    return true;
  }
  /**
   * Клиент уже звонил абоненту столько, сколько разрешено за час или сутки (ADR-0106). С транзакцией — под
   * блокировкой пары «клиент, абонент»: проверка в транзакции вызова держит предел при одновременных заявках.
   */
  async recipientExceeded(
    clientId: Id<'client'>,
    destination: string,
    now: Date,
    tx?: Executor,
  ): Promise<boolean> {
    const limits = await this.settings.callRecipientLimits();
    if (limits.perHour <= 0 && limits.perDay <= 0) return false;
    if (tx !== undefined) await this.calls.lockRecipient(clientId, destination, tx);
    const used = await this.calls.recipientCalls(clientId, destination, now, tx);
    return (
      (limits.perHour > 0 && used.hour >= limits.perHour) ||
      (limits.perDay > 0 && used.day >= limits.perDay)
    );
  }

  /**
   * Номер клиента, который видит абонент, звонил через SIP-провайдеров столько, сколько разрешено за час или сутки
   * (ADR-0108): дальше вызовы этой линии идут только через SIM, где абонент видит номер SIM. Без блокировки: предел
   * мягкий, одновременные заявки перешагнут его на единицы, а запирать каждый вызов клиента ради этого дорого.
   */
  async callerIdExceeded(callerId: string | null, now: Date): Promise<boolean> {
    if (callerId === null) return false;
    const limits = await this.settings.callerIdLimits();
    if (limits.perHour <= 0 && limits.perDay <= 0) return false;
    const used = await this.calls.callerIdCalls(callerId, now);
    return (
      (limits.perHour > 0 && used.hour >= limits.perHour) ||
      (limits.perDay > 0 && used.day >= limits.perDay)
    );
  }

  private async startWarmup(number: PacedNumber, now: Date, tx: Executor): Promise<void> {
    await this.telephony.startWarmup(
      number.kind === 'sim'
        ? { sim: number.id as Id<'simCard'> }
        : { trunk: number.id as Id<'gateway'> },
      now,
      tx,
    );
  }
}
