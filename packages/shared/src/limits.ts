/**
 * Лимиты по окнам ([ADR-0026](../../../docs/adr/0026-limity-po-oknam.md)).
 *
 * Окно фиксированное и календарное, а не скользящее: скользящее потребовало бы хранить
 * отметку каждого вызова — таблицу, растущую с трафиком, — ради квоты, которую человек
 * всё равно формулирует календарно («пятьсот звонков в сутки»). У фиксированного окна
 * видно, когда счётчик обнулится.
 *
 * Часовой пояс — **UTC**. «Сутки» без указания пояса — это спор, который случится
 * один раз и дорого.
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
export const LIMIT_METRICS = ['calls', 'minutes'] as const;
export type LimitMetric = (typeof LIMIT_METRICS)[number];

/**
 * Как разговор идёт в счётчик минут ([ADR-0057](../../../docs/adr/0057-limity-partnyora.md)):
 * `second` — как есть, `minute` — каждый разговор округляется вверх до целой минуты,
 * как считает пакет оператора. У звонков — всегда `second`: округлять там нечего.
 */
export const LIMIT_ROUNDINGS = ['second', 'minute'] as const;
export type LimitRounding = (typeof LIMIT_ROUNDINGS)[number];

/** Кто задал правило: площадка или сам партнёр (ADR-0057). Партнёр меняет только свои. */
export const LIMIT_SET_BY = ['platform', 'partner'] as const;
export type LimitSetBy = (typeof LIMIT_SET_BY)[number];

/** День обновления месячного окна: до 28-го, потому что в феврале 29-го нет. */
export const LIMIT_PERIOD_START_DAY_MAX = 28;

const MS_PER_DAY = 86_400_000;

/**
 * Начало окна, в которое попадает момент.
 *
 * Чистая функция: то же значение вычисляется и при проверке, и при инкременте,
 * и в проверках. Расхождение здесь означало бы, что счётчик пишется в одно окно,
 * а читается из другого — то есть квота не работает вовсе.
 */
export function bucketStart(
  window: LimitWindow,
  at: Date,
  /** День обновления месячного окна (1–28); пусто — первое число. */
  periodStartDay: number | null = null,
): Date {
  const time = at.getTime();
  switch (window) {
    case 'minute':
      return new Date(time - (time % 60_000));
    case 'hour':
      return new Date(
        Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()),
      );
    case 'day':
      return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    case 'week': {
      // Неделя начинается с понедельника: `getUTCDay` считает воскресенье нулём,
      // и без сдвига неделя началась бы с него.
      const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
      const weekday = (new Date(midnight).getUTCDay() + 6) % 7;
      return new Date(midnight - weekday * MS_PER_DAY);
    }
    case 'month': {
      // Пакет оператора обновляется в день подключения тарифа: до этого дня в текущем
      // месяце окно ещё прошломесячное.
      const day = periodStartDay ?? 1;
      const year = at.getUTCFullYear();
      const month = at.getUTCMonth() - (at.getUTCDate() < day ? 1 : 0);
      return new Date(Date.UTC(year, month, day));
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
 * Когда окно, в которое попадает момент, закончится — и счётчик обнулится.
 * Кабинет показывает его местным временем: окна считаются в UTC (ADR-0026).
 */
export function bucketEnd(
  window: LimitWindow,
  at: Date,
  periodStartDay: number | null = null,
): Date {
  const start = bucketStart(window, at, periodStartDay);
  switch (window) {
    case 'minute':
      return new Date(start.getTime() + 60_000);
    case 'hour':
      return new Date(start.getTime() + 3_600_000);
    case 'day':
      return new Date(start.getTime() + MS_PER_DAY);
    case 'week':
      return new Date(start.getTime() + 7 * MS_PER_DAY);
    case 'month':
      return new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()),
      );
    default: {
      const exhaustive: never = window;
      throw new Error(`Неизвестное окно лимита: ${String(exhaustive)}`);
    }
  }
}

/**
 * Во сколько единиц метрики обходится вызов длительностью `seconds`.
 * Поминутный счёт округляет каждый разговор вверх до целой минуты (ADR-0057).
 */
export function amountFor(
  metric: LimitMetric,
  seconds: number,
  rounding: LimitRounding = 'second',
): number {
  if (metric === 'calls') return 1;
  return rounding === 'minute' ? Math.ceil(seconds / 60) * 60 : seconds;
}

/** Предел в единицах хранения: минуты задаются человеком, копятся секундами. */
export function limitInStoredUnits(metric: LimitMetric, value: number): number {
  return metric === 'calls' ? value : value * 60;
}
