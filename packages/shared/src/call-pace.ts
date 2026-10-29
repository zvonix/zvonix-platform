/**
 * Прогрев и рекомендованная работа номера — SIM или SIP-транка
 * ([ADR-0105](../../../docs/adr/0105-progrev-i-rekomendovannaya-rabota-nomera.md)).
 *
 * Оператор блокирует номер за поток звонков, непохожий на человека, и за новый номер под полной нагрузкой. Пороги
 * не публикуются, поэтому числа — осторожная оценка; площадка меняет их в настройках.
 */

/** Первая неделя по суткам (с нуля): столько попыток за скользящие сутки разрешено новому номеру. */
export const CALL_WARMUP_FIRST_WEEK = [10, 15, 20, 30, 40, 50, 60] as const;

/** К этим суткам номер доходит до рекомендованного «в сутки»; дальше прогрева нет. */
export const CALL_WARMUP_DAYS = 14;

/** Номер, молчавший столько суток, — новый: прогрев начинается заново. */
export const CALL_WARMUP_IDLE_DAYS = 14;

/** Куда растёт прогрев, когда рекомендованное «в сутки» не задано (0 — не ограничивать). */
export const CALL_WARMUP_FALLBACK_CEILING = 150;

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
}

/** Пределы номера сейчас: `null` — без предела. */
export interface CallPace {
  readonly perHour: number | null;
  readonly perDay: number | null;
  /** Сутки прогрева (с нуля) или `null` — прогрет либо прогрев выключен. */
  readonly warmupDay: number | null;
}

/**
 * Пределы номера: при прогреве — сутки по кривой и тройная часовая доля (не меньше 2 и не больше рекомендованного
 * «в час»: вызовы такси идут волнами), после — рекомендованные. Всё умножается на число номеров транка.
 */
export function callPace(
  settings: CallPaceSettings,
  warmupDay: number | null,
  numbers = 1,
): CallPace {
  const scale = (value: number | null): number | null => (value === null ? null : value * numbers);
  const perHour = settings.perHour > 0 ? settings.perHour : null;
  const perDay = settings.perDay > 0 ? settings.perDay : null;
  if (!settings.warmupEnabled || warmupDay === null) {
    return { perHour: scale(perHour), perDay: scale(perDay), warmupDay: null };
  }
  const daily = callWarmupDailyLimit(warmupDay, perDay ?? CALL_WARMUP_FALLBACK_CEILING);
  const spread = Math.max(2, Math.ceil((daily * 3) / 24));
  return {
    perHour: scale(perHour === null ? spread : Math.min(perHour, spread)),
    perDay: scale(daily),
    warmupDay,
  };
}
