/**
 * Прогрев и рекомендованная работа номера — SIM или SIP-транка
 * ([ADR-0105](../../../../../docs/adr/0105-progrev-i-rekomendovannaya-rabota-nomera.md)).
 *
 * Окна скользящие и считаются по таблице вызовов: вызов и так пишется той же транзакцией, что занимает номер, и
 * отдельный счётчик был бы второй копией того же факта.
 */

import { Injectable } from '@nestjs/common';
import {
  callPace,
  callRestingUntil,
  callRestWindowMs,
  callWarmupDay,
  isIdleNumber,
  type CallPace,
  type CallPaceSettings,
  type Id,
} from '@zvonix/shared';
import { SettingsService } from '../settings/settings.service.js';
import { CallRepository, type Executor, type NumberAttempts } from './call.repository.js';
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
}

const NO_ATTEMPTS: NumberAttempts = {
  hour: 0,
  day: 0,
  distinctHour: 0,
  distinctDay: 0,
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
  return { kind: 'sim', id: sim.id, warmupStartedAt: sim.warmupStartedAt, numbers: 1 };
}

export function pacedTrunk(row: { gateway: GatewayRow; trunk: SipTrunkRow }): PacedNumber {
  return {
    kind: 'sip',
    id: row.gateway.id,
    warmupStartedAt: row.trunk.warmupStartedAt,
    numbers: row.trunk.numbersCount,
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
  };
}

function paceOf(
  settings: CallPaceSettings,
  number: PacedNumber,
  attempts: NumberAttempts,
  now: Date,
): NumberPace {
  const pace = callPace(
    settings,
    callWarmupDay(number.warmupStartedAt, attempts.lastAt, now),
    number.numbers,
  );
  return {
    ...pace,
    usedHour: attempts.hour,
    usedDay: attempts.day,
    distinctUsedHour: attempts.distinctHour,
    distinctUsedDay: attempts.distinctDay,
    calledHour: attempts.calledHour,
    calledDay: attempts.calledDay,
    restingUntil: callRestingUntil(pace, attempts.ended, now),
    idle: isIdleNumber(attempts.lastAt, now),
  };
}

/**
 * Номеру сейчас звонить нельзя: исчерпаны попытки, номер отдыхает после прошлого вызова или исчерпал разных абонентов —
 * кроме абонента, которому он уже звонил в этом окне (ADR-0106).
 */
function exhausted(pace: NumberPace): boolean {
  return (
    (pace.perHour !== null && pace.usedHour >= pace.perHour) ||
    (pace.perDay !== null && pace.usedDay >= pace.perDay) ||
    pace.restingUntil !== null ||
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
    const settings = await this.settings.callPace();
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
      result.set(number.id, paceOf(settings, number, attempts, now));
    }
    return result;
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
