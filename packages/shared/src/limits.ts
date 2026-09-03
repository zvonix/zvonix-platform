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

/** Длительность окна. Начало вычисляется `bucketStart`. */
export const LIMIT_WINDOWS = ['hour', 'day', 'week', 'month'] as const;
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

const MS_PER_DAY = 86_400_000;

/**
 * Начало окна, в которое попадает момент.
 *
 * Чистая функция: то же значение вычисляется и при проверке, и при инкременте,
 * и в проверках. Расхождение здесь означало бы, что счётчик пишется в одно окно,
 * а читается из другого — то есть квота не работает вовсе.
 */
export function bucketStart(window: LimitWindow, at: Date): Date {
  const time = at.getTime();
  switch (window) {
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
    case 'month':
      return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    default: {
      // Перечисление закрыто; ветка существует, чтобы новое окно нельзя было добавить,
      // забыв про его начало.
      const exhaustive: never = window;
      throw new Error(`Неизвестное окно лимита: ${String(exhaustive)} (${String(time)})`);
    }
  }
}

/** Во сколько единиц метрики обходится вызов длительностью `seconds`. */
export function amountFor(metric: LimitMetric, seconds: number): number {
  return metric === 'calls' ? 1 : seconds;
}

/** Предел в единицах хранения: минуты задаются человеком, копятся секундами. */
export function limitInStoredUnits(metric: LimitMetric, value: number): number {
  return metric === 'calls' ? value : value * 60;
}
