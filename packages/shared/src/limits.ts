/**
 * Лимиты по окнам ([ADR-0026](../../../docs/adr/0026-limity-po-oknam.md)).
 *
 * Окно фиксированное и календарное, а не скользящее: скользящее потребовало бы хранить
 * отметку каждого вызова — таблицу, растущую с трафиком, — ради квоты, которую человек
 * всё равно формулирует календарно («пятьсот звонков в сутки»). У фиксированного окна
 * видно, когда счётчик обнулится.
 *
 * Часовой пояс — **владельца** ([ADR-0102](../../../docs/adr/0102-chasovoy-poyas-akkaunta-i-limity.md)):
 * сутки клиента из Новосибирска начинаются в полночь по Новосибирску. Пояс хранится у правила копией
 * пояса аккаунта; у правил, заведённых до этого, — `UTC`, как и было.
 */

/**
 * Длительность окна. Начало вычисляется `bucketStart`.
 *
 * `minute` — частые звонки с карты оператор замечает раньше суточных
 * ([ADR-0057](../../../docs/adr/0057-limity-partnyora.md)).
 */
export const LIMIT_WINDOWS = ['minute', 'hour', 'day', 'week', 'month'] as const;
export type LimitWindow = (typeof LIMIT_WINDOWS)[number];

/**
 * Что считается в окне.
 *
 * `calls` — попытки вызова, известны сразу; `minutes` — разговор, известен только
 * по CDR. Отсюда разница: квота по минутам может быть перебрана на длительность
 * одного вызова, и это принятая цена (ADR-0026).
 */
export const LIMIT_METRICS = ['calls', 'minutes', 'money'] as const;
export type LimitMetric = (typeof LIMIT_METRICS)[number];

/**
 * Что считается у партнёра: звонки и минуты его карт. Денег у партнёра на звонки нет — `money` бывает только
 * у клиента и его линий: сколько он потратил ([ADR-0102](../../../docs/adr/0102-chasovoy-poyas-akkaunta-i-limity.md)).
 */
export const PARTNER_LIMIT_METRICS = ['calls', 'minutes'] as const satisfies readonly LimitMetric[];

/** Микроединиц в рубле: лимит денег задаётся рублями, копится микроединицами, как и все деньги. */
const MICROS_PER_RUBLE = 1_000_000;

/**
 * Как разговор идёт в счётчик минут ([ADR-0057](../../../docs/adr/0057-limity-partnyora.md)):
 * `second` — как есть, `minute` — каждый разговор округляется вверх до целой минуты,
 * как считает пакет оператора. У звонков — всегда `second`: округлять там нечего.
 */
export const LIMIT_ROUNDINGS = ['second', 'minute'] as const;
export type LimitRounding = (typeof LIMIT_ROUNDINGS)[number];

/**
 * Кто задал правило: площадка, сам партнёр (ADR-0057) или сам клиент (ADR-0102). Партнёр и клиент меняют только
 * свои правила; правила площадки им видны, но не меняются.
 */
export const LIMIT_SET_BY = ['platform', 'partner', 'client'] as const;
export type LimitSetBy = (typeof LIMIT_SET_BY)[number];

/** День обновления месячного окна: до 28-го, потому что в феврале 29-го нет. */
export const LIMIT_PERIOD_START_DAY_MAX = 28;

/** Пояс правил, заведённых до ADR-0102, и аккаунта, где пояс не выбран: окна считаются, как раньше. */
export const LIMIT_TIMEZONE_FALLBACK = 'UTC';

/** Пояс нового аккаунта: большинство клиентов и партнёров — по московскому времени. */
export const DEFAULT_ACCOUNT_TIMEZONE = 'Europe/Moscow';

/**
 * Имя пояса IANA, которое знает среда (`Europe/Novosibirsk`), или `UTC`. Сокращения вроде `MSK` и смещения вроде
 * `+07:00` не принимаются: у смещения нет летнего времени, а у сокращения — однозначности.
 */
export function isTimeZone(value: string): boolean {
  if (value === LIMIT_TIMEZONE_FALLBACK) return true;
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/u.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Форматтер на пояс: создание дорогое, а горячий путь считает окна на каждом вызове. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/** Местные часы в поясе: год, месяц с нуля, число, час, минута, секунда. */
interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallClock(at: Date, timeZone: string): WallClock {
  const parts = new Map(
    formatterOf(timeZone)
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  const part = (name: Intl.DateTimeFormatPartTypes): number => parts.get(name) ?? 0;
  return {
    year: part('year'),
    month: part('month') - 1,
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  };
}

/** Смещение пояса от UTC в момент `at`, в миллисекундах (Новосибирск — +7 ч). */
function offsetAt(at: Date, timeZone: string): number {
  const clock = wallClock(at, timeZone);
  const asUtc = Date.UTC(
    clock.year,
    clock.month,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Момент, когда в поясе на часах `year-month-day hour:00`. Месяц и число могут выходить за границы — `Date.UTC`
 * переносит их сам (32 октября — 1 ноября).
 *
 * Смещение берётся дважды: первое — на момент «как если бы это было UTC», второе — на найденный момент. Разница
 * между ними бывает только у перехода на летнее время, и второе тогда правильное. Местного времени, которого
 * не было (часы перевели вперёд), не существует: берётся первый момент после перевода.
 */
function zonedTime(timeZone: string, year: number, month: number, day: number, hour = 0): Date {
  const wall = Date.UTC(year, month, day, hour);
  const first = wall - offsetAt(new Date(wall), timeZone);
  const second = wall - offsetAt(new Date(first), timeZone);
  return new Date(Math.max(first, second));
}

/**
 * Начало окна, в которое попадает момент.
 *
 * Чистая функция: то же значение вычисляется и при проверке, и при инкременте,
 * и в проверках. Расхождение здесь означало бы, что счётчик пишется в одно окно,
 * а читается из другого — то есть квота не работает вовсе.
 *
 * Пояс — правила ([ADR-0102](../../../docs/adr/0102-chasovoy-poyas-akkaunta-i-limity.md)): полночь местная,
 * с летним временем. `UTC` даёт ровно прежние окна.
 */
export function bucketStart(
  window: LimitWindow,
  at: Date,
  /** День обновления месячного окна (1–28); пусто — первое число. */
  periodStartDay: number | null = null,
  timeZone: string = LIMIT_TIMEZONE_FALLBACK,
): Date {
  const time = at.getTime();
  if (window === 'minute') {
    // Смещения поясов кратны минуте — минута одна и та же везде.
    return new Date(time - (time % 60_000));
  }
  const clock = wallClock(at, timeZone);
  switch (window) {
    case 'hour':
      return zonedTime(timeZone, clock.year, clock.month, clock.day, clock.hour);
    case 'day':
      return zonedTime(timeZone, clock.year, clock.month, clock.day);
    case 'week': {
      // Неделя начинается с понедельника: `getUTCDay` считает воскресенье нулём,
      // и без сдвига неделя началась бы с него.
      const weekday = (new Date(Date.UTC(clock.year, clock.month, clock.day)).getUTCDay() + 6) % 7;
      return zonedTime(timeZone, clock.year, clock.month, clock.day - weekday);
    }
    case 'month': {
      // Пакет оператора обновляется в день подключения тарифа: до этого дня в текущем
      // месяце окно ещё прошломесячное.
      const day = periodStartDay ?? 1;
      const month = clock.month - (clock.day < day ? 1 : 0);
      return zonedTime(timeZone, clock.year, month, day);
    }
    default: {
      // Перечисление закрыто; ветка существует, чтобы новое окно нельзя было добавить,
      // забыв про его начало.
      const exhaustive: never = window;
      throw new Error(`Неизвестное окно лимита: ${String(exhaustive)} (${String(time)})`);
    }
  }
}

/**
 * Когда окно, в которое попадает момент, закончится — и счётчик обнулится. Конец считается по местным часам,
 * а не прибавлением суток: в день перевода часов сутки длятся 23 или 25 часов.
 */
export function bucketEnd(
  window: LimitWindow,
  at: Date,
  periodStartDay: number | null = null,
  timeZone: string = LIMIT_TIMEZONE_FALLBACK,
): Date {
  const start = bucketStart(window, at, periodStartDay, timeZone);
  if (window === 'minute') return new Date(start.getTime() + 60_000);
  const clock = wallClock(start, timeZone);
  switch (window) {
    case 'hour':
      return zonedTime(timeZone, clock.year, clock.month, clock.day, clock.hour + 1);
    case 'day':
      return zonedTime(timeZone, clock.year, clock.month, clock.day + 1);
    case 'week':
      return zonedTime(timeZone, clock.year, clock.month, clock.day + 7);
    case 'month':
      return zonedTime(timeZone, clock.year, clock.month + 1, clock.day);
    default: {
      const exhaustive: never = window;
      throw new Error(`Неизвестное окно лимита: ${String(exhaustive)}`);
    }
  }
}

/**
 * Во сколько единиц метрики обходится вызов: длительностью `seconds` и стоимостью `micros` для клиента.
 * Поминутный счёт округляет каждый разговор вверх до целой минуты (ADR-0057).
 */
export function amountFor(
  metric: LimitMetric,
  call: { readonly seconds: number; readonly micros?: number },
  rounding: LimitRounding = 'second',
): number {
  switch (metric) {
    case 'calls':
      return 1;
    case 'minutes':
      return rounding === 'minute' ? Math.ceil(call.seconds / 60) * 60 : call.seconds;
    case 'money':
      return call.micros ?? 0;
  }
}

/**
 * Предел в единицах хранения: минуты задаются человеком, копятся секундами; рубли — микроединицами.
 * Потолок значения (10 млн рублей) — 10¹³ микроединиц, безопасно для `number`.
 */
export function limitInStoredUnits(metric: LimitMetric, value: number): number {
  switch (metric) {
    case 'calls':
      return value;
    case 'minutes':
      return value * 60;
    case 'money':
      return value * MICROS_PER_RUBLE;
  }
}
