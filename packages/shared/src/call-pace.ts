/**
 * Прогрев и рекомендованная работа номера — SIM или SIP-транка
 * ([ADR-0105](../../../docs/adr/0105-progrev-i-rekomendovannaya-rabota-nomera.md)).
 *
 * Оператор блокирует номер за поток звонков, непохожий на человека, и за новый номер под полной нагрузкой. Пороги
 * не публикуются, поэтому числа — осторожная оценка; площадка меняет их в настройках.
 */

import { jitteredPauseMs, PACE_JITTER_SHARE } from './pace-jitter.js';

/** Первая неделя по суткам (с нуля): столько попыток за скользящие сутки разрешено новому номеру. */
export const CALL_WARMUP_FIRST_WEEK = [10, 15, 20, 30, 40, 50, 60] as const;

/** К этим суткам номер доходит до рекомендованного «в сутки»; дальше прогрева нет. */
export const CALL_WARMUP_DAYS = 14;

/** Номер, молчавший столько суток, — новый: прогрев начинается заново. */
export const CALL_WARMUP_IDLE_DAYS = 14;

/** Куда растёт прогрев, когда рекомендованное «в сутки» не задано (0 — не ограничивать). */
export const CALL_WARMUP_FALLBACK_CEILING = 100;

/**
 * «Плохой» номер ([ADR-0107](../../../docs/adr/0107-son-nomera-plokhoy-nomer-i-otchyot-blokirovok.md)): меньше этого
 * попыток за сутки — о доле ответов судить рано.
 */
export const CALL_POOR_MIN_ATTEMPTS = 20;

/** Настоящий ответ — разговор не короче стольких секунд: сброс в первые секунды оператор видит как недозвон. */
export const CALL_REAL_ANSWER_SECONDS = 5;

/** Сколько номеров бывает у одного SIP-транка. */
export const TRUNK_NUMBERS_MAX = 1000;

const DAY_MS = 86_400_000;

/**
 * Предел попыток за скользящие сутки на `day`-е сутки прогрева (с нуля): неделя — {@link CALL_WARMUP_FIRST_WEEK},
 * дальше линейно до `ceiling` к {@link CALL_WARMUP_DAYS}-м суткам. Не выше `ceiling`.
 */
export function callWarmupDailyLimit(day: number, ceiling: number): number {
  if (day >= CALL_WARMUP_DAYS) return ceiling;
  const lastOfWeek = CALL_WARMUP_FIRST_WEEK[CALL_WARMUP_FIRST_WEEK.length - 1] ?? 0;
  const base =
    day < CALL_WARMUP_FIRST_WEEK.length
      ? (CALL_WARMUP_FIRST_WEEK[day] ?? 0)
      : lastOfWeek +
        Math.round(
          ((Math.max(ceiling, lastOfWeek) - lastOfWeek) *
            (day - (CALL_WARMUP_FIRST_WEEK.length - 1))) /
            (CALL_WARMUP_DAYS - (CALL_WARMUP_FIRST_WEEK.length - 1)),
        );
  return Math.min(ceiling, base);
}

/**
 * Сутки прогрева номера (с нуля) или `null` — номер прогрет.
 *
 * Номер без попыток за {@link CALL_WARMUP_IDLE_DAYS} суток — новый: сутки 0, отсчёт начнёт этот вызов. Звонивший
 * без отметки начала — прогретый: так встречают номера, работавшие до прогрева.
 */
export function callWarmupDay(
  startedAt: Date | null,
  lastCallAt: Date | null,
  now: Date,
): number | null {
  if (isIdleNumber(lastCallAt, now)) return 0;
  if (startedAt === null) return null;
  const day = Math.floor((now.getTime() - startedAt.getTime()) / DAY_MS);
  return day >= CALL_WARMUP_DAYS ? null : Math.max(0, day);
}

/** Номер без попыток за {@link CALL_WARMUP_IDLE_DAYS} суток — новый. */
export function isIdleNumber(lastCallAt: Date | null, now: Date): boolean {
  return (
    lastCallAt === null || now.getTime() - lastCallAt.getTime() >= CALL_WARMUP_IDLE_DAYS * DAY_MS
  );
}

/** Настройки площадки: 0 — не ограничивать. */
export interface CallPaceSettings {
  readonly warmupEnabled: boolean;
  readonly perHour: number;
  readonly perDay: number;
  /**
   * Разный предел по дням ([ADR-0116](../../../docs/adr/0116-raznyy-sutochnyy-predel-po-dnyam.md)): предел дня ниже на
   * долю до этого процента, свою у номера; 0 — каждый день одинаково.
   */
  readonly dailyVariationPercent: number;
  /** Пауза номера после конца вызова, секунд ([ADR-0106](../../../docs/adr/0106-rovnyy-temp-nomera-i-abonenty.md)). */
  readonly pauseSeconds: number;
  /** То же, пока номер на прогреве. */
  readonly warmupPauseSeconds: number;
  /** Разных абонентов на номер за скользящие час и сутки. */
  readonly distinctPerHour: number;
  readonly distinctPerDay: number;
  /** Часов сна номера в сутки (ADR-0107); 0 — не спит. */
  readonly sleepHours: number;
  /** Доля настоящих ответов, ниже которой номер замедляется, %; 0 — не замедлять. */
  readonly poorAnswerPercent: number;
  /**
   * Автоторможение оператора ([ADR-0108](../../../docs/adr/0108-avtotormozhenie-operatora-i-sip.md)): столько SIM оператора, снятых порогом
   * отказов за {@link CALL_BRAKE_DAYS} суток, тормозят все его номера; 0 — выключено.
   */
  readonly brakeSuspensions: number;
  /** Сколько от пределов остаётся заторможенному номеру, %. */
  readonly brakePercent: number;
  /** Вызовов в секунду у SIP-провайдера: вызовы транка идут ровным шагом, а не пачкой; 0 — без предела. */
  readonly trunkCallsPerSecond: number;
}

/**
 * Настройки номера партнёра, выключившего рекомендации площадки
 * ([ADR-0117](../../../docs/adr/0117-partner-vybiraet-temp-kart.md)): без прогрева, пределов в час и в сутки, разных
 * абонентов, замедления «плохого» номера и разного предела по дням. Пауза после звонка и сон остаются — защита от вида
 * программы; пауза прогрева не действует, потому что прогрева нет. Автоторможение выключает вызывающий.
 */
export function withoutRecommendedPace(settings: CallPaceSettings): CallPaceSettings {
  return {
    ...settings,
    warmupEnabled: false,
    perHour: 0,
    perDay: 0,
    distinctPerHour: 0,
    distinctPerDay: 0,
    poorAnswerPercent: 0,
    dailyVariationPercent: 0,
  };
}

/** Окно автоторможения: снятия старше этого номера оператора уже не тормозят. */
export const CALL_BRAKE_DAYS = 7;

/** Пределы номера сейчас: `null` — без предела. */
export interface CallPace {
  readonly perHour: number | null;
  readonly perDay: number | null;
  /** Сутки прогрева (с нуля) или `null` — прогрет либо прогрев выключен. */
  readonly warmupDay: number | null;
  /** Пауза после конца вызова, секунд, без разброса; `null` — без паузы. */
  readonly pauseSeconds: number | null;
  /** Сколько вызовов номера может «отдыхать» одновременно: у SIM один, у транка — число его номеров. */
  readonly numbers: number;
  readonly distinctPerHour: number | null;
  readonly distinctPerDay: number | null;
  /** «Плохой» номер: пределы в час, в сутки и по абонентам — вдвое ниже (ADR-0107). */
  readonly poor: boolean;
  /** Оператор номера тормозит (ADR-0108): пределы — `brakePercent` от обычных. */
  readonly braked: boolean;
}

/**
 * «Плохой» номер: за сутки не меньше {@link CALL_POOR_MIN_ATTEMPTS} попыток, а настоящих ответов меньше `percent` %.
 */
export function isPoorNumber(attempts: number, realAnswers: number, percent: number): boolean {
  return (
    percent > 0 && attempts >= CALL_POOR_MIN_ATTEMPTS && realAnswers * 100 < attempts * percent
  );
}

const positive = (value: number): number | null => (value > 0 ? value : null);

/**
 * Пределы номера: при прогреве — сутки по кривой и тройная часовая доля (не меньше 2 и не больше рекомендованного
 * «в час»: вызовы идут волнами) и пауза прогрева, после — рекомендованные. Всё, кроме паузы, умножается на число
 * номеров транка: пауза у каждого номера своя, а их число задаёт `numbers`. У «плохого» номера пределы вдвое ниже,
 * у заторможенного — `brakePercent` от обычных; оба вместе перемножаются. Ниже единицы предел не падает.
 */
export function callPace(
  settings: CallPaceSettings,
  warmupDay: number | null,
  numbers = 1,
  poor = false,
  braked = false,
): CallPace {
  // Целые проценты в десятитысячных: дробей с плавающей точкой в пределе нет.
  const share =
    (poor ? 50 : 100) * (braked ? Math.min(100, Math.max(1, settings.brakePercent)) : 100);
  const scale = (value: number | null): number | null =>
    value === null
      ? null
      : share === 10_000
        ? value * numbers
        : Math.max(1, Math.ceil((value * numbers * share) / 10_000));
  const perHour = positive(settings.perHour);
  const perDay = positive(settings.perDay);
  const common = {
    numbers,
    poor,
    braked,
    distinctPerHour: scale(positive(settings.distinctPerHour)),
    distinctPerDay: scale(positive(settings.distinctPerDay)),
  };
  if (!settings.warmupEnabled || warmupDay === null) {
    return {
      ...common,
      perHour: scale(perHour),
      perDay: scale(perDay),
      warmupDay: null,
      pauseSeconds: positive(settings.pauseSeconds),
    };
  }
  const daily = callWarmupDailyLimit(warmupDay, perDay ?? CALL_WARMUP_FALLBACK_CEILING);
  const spread = Math.max(2, Math.ceil((daily * 3) / 24));
  return {
    ...common,
    perHour: scale(perHour === null ? spread : Math.min(perHour, spread)),
    perDay: scale(daily),
    warmupDay,
    // Пауза прогрева не короче обычной: выключенная обычная прогрев не отменяет.
    pauseSeconds: positive(Math.max(settings.warmupPauseSeconds, settings.pauseSeconds)),
  };
}

/**
 * Ровный шаг транка ([ADR-0108](../../../docs/adr/0108-avtotormozhenie-operatora-i-sip.md)): следующий вызов — не раньше `1000 / perSecond` мс после
 * прошлого начала. `null` — можно звонить сейчас или предел выключен.
 */
export function trunkSpacedUntil(lastAt: Date | null, perSecond: number, now: Date): Date | null {
  if (perSecond <= 0 || lastAt === null) return null;
  const next = lastAt.getTime() + Math.ceil(1000 / perSecond);
  return next > now.getTime() ? new Date(next) : null;
}

/** Самая длинная пауза с разбросом — глубже прошлые вызовы для паузы не ищутся. */
export function callRestWindowMs(settings: CallPaceSettings): number {
  return Math.ceil(
    Math.max(settings.pauseSeconds, settings.warmupPauseSeconds, 0) *
      1000 *
      (1 + PACE_JITTER_SHARE),
  );
}

/**
 * До какого времени номер отдыхает после прошлых вызовов: каждый закончившийся вызов держит одно место на свою паузу
 * с разбросом по идентификатору вызова. Мест у номера `pace.numbers`; заняты все — номер отдыхает до освобождения
 * первого. `null` — свободен.
 */
export function callRestingUntil(
  pace: Pick<CallPace, 'pauseSeconds' | 'numbers'>,
  ended: readonly { readonly id: string; readonly endedAt: Date }[],
  now: Date,
): Date | null {
  if (pace.pauseSeconds === null) return null;
  const pauseSeconds = pace.pauseSeconds;
  const resting = ended
    .map((call) => call.endedAt.getTime() + jitteredPauseMs(pauseSeconds, call.id))
    .filter((until) => until > now.getTime())
    .sort((left, right) => left - right);
  if (resting.length < pace.numbers) return null;
  return new Date(resting[resting.length - pace.numbers] ?? now.getTime());
}
