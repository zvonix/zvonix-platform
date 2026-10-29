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
}

const NO_ATTEMPTS: NumberAttempts = { hour: 0, day: 0, lastAt: null };

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
}

export function toPaceView(pace: NumberPace): NumberPaceView {
  return {
    warmup_day: pace.warmupDay === null ? null : pace.warmupDay + 1,
    per_hour: pace.perHour,
    per_day: pace.perDay,
    used_hour: pace.usedHour,
    used_day: pace.usedDay,
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
  return { ...pace, usedHour: attempts.hour, usedDay: attempts.day };
}

function exhausted(pace: NumberPace): boolean {
  return (
    (pace.perHour !== null && pace.usedHour >= pace.perHour) ||
    (pace.perDay !== null && pace.usedDay >= pace.perDay)
  );
}

@Injectable()
export class CallPaceService {
  constructor(
    private readonly calls: CallRepository,
    private readonly telephony: TelephonyRepository,
    private readonly settings: SettingsService,
  ) {}

  /** Пределы и израсходованное у каждого номера — для отбора кандидатов и для кабинета. */
  async paces(
    numbers: readonly PacedNumber[],
    now: Date,
    executor?: Executor,
  ): Promise<Map<string, NumberPace>> {
    const settings = await this.settings.callPace();
    const [sims, trunks] = await Promise.all([
      this.calls.numberAttempts(
        'sim',
        numbers.filter((number) => number.kind === 'sim').map((number) => number.id),
        now,
        executor,
      ),
      this.calls.numberAttempts(
        'gateway',
        numbers.filter((number) => number.kind === 'sip').map((number) => number.id),
        now,
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

  /** Номера кандидатов, исчерпавшие предел: SIM — по её идентификатору, транк — по шлюзу. */
  async exhausted(candidates: readonly TerminationCandidate[], now: Date): Promise<Set<string>> {
    const paces = await this.paces(candidates.map(pacedNumberOf), now);
    return new Set([...paces].filter(([, pace]) => exhausted(pace)).map(([id]) => id));
  }

  /**
   * Пускает вызов на номер: в транзакции вызова, **после** блокировки строки SIM или транка — иначе две одновременные
   * заявки насчитали бы одно и то же и прошли обе. Номер, молчавший 14 суток, начинает прогрев этим вызовом.
   */
  async admit(candidate: TerminationCandidate, now: Date, tx: Executor): Promise<boolean> {
    const number = pacedNumberOf(candidate);
    const settings = await this.settings.callPace();
    const attempts =
      (
        await this.calls.numberAttempts(
          number.kind === 'sim' ? 'sim' : 'gateway',
          [number.id],
          now,
          tx,
        )
      ).get(number.id) ?? NO_ATTEMPTS;
    if (exhausted(paceOf(settings, number, attempts, now))) return false;
    if (isIdleNumber(attempts.lastAt, now)) await this.startWarmup(number, now, tx);
    return true;
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
