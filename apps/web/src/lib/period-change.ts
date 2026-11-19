/**
 * Изменение показателя к такому же периоду перед ним — для плиток «Обзора».
 *
 * Процент имеет смысл, пока прошлое значение сопоставимо с нынешним. Когда раньше было почти ноль
 * (несколько копеек, один вызов), деление на него даёт «+972 400,0 % к прошлому периоду» — число верное
 * и бесполезное (владелец, 2026-11-19). Поэтому за порогом процент заменяется словами.
 */

/**
 * Порог процента, за которым пишется «раньше почти не было»: рост больше чем в одиннадцать раз.
 *
 * Тысяча процентов выбрана потому, что до неё процент ещё читается как изменение («вдвое», «в пять раз
 * больше» — 100 %, 400 %), а за ней прошлое значение — уже не база, а остаток: для решения разница между
 * +1 500 % и +970 000 % не важна, важно, что раньше этого почти не было.
 */
export const PERCENT_LIMIT = 1000;

export type PeriodChange =
  /** Сравнивать не с чем: нет данных о прошлом периоде или о доле в нём. */
  | { readonly kind: 'unknown' }
  /** Раньше был ноль, теперь есть. */
  | { readonly kind: 'new' }
  /** Раньше было так мало, что процент вышел за `PERCENT_LIMIT`. */
  | { readonly kind: 'almost_new' }
  /** Обратный случай, возможный лишь при отрицательном прошлом значении (доход в минусе). */
  | { readonly kind: 'much_less' }
  | { readonly kind: 'percent'; readonly value: number };

/**
 * Изменение `now` к `before` в процентах — или словами, когда процент ничего не говорит.
 *
 * Делится на модуль прошлого значения: «наш доход» бывает отрицательным, и при делении на минус рост
 * с −10 ₽ до +10 ₽ выходил бы падением на 200 %.
 */
export function periodChange(now: number, before: number): PeriodChange {
  if (!Number.isFinite(now) || !Number.isFinite(before)) return { kind: 'unknown' };
  if (before === 0) return now === 0 ? { kind: 'percent', value: 0 } : { kind: 'new' };
  const value = ((now - before) / Math.abs(before)) * 100;
  if (value > PERCENT_LIMIT) return { kind: 'almost_new' };
  if (value < -PERCENT_LIMIT) return { kind: 'much_less' };
  return { kind: 'percent', value };
}

/** Направление для цвета: рост, падение или «без изменений» (меньше 0,05 — это округлится в ноль). */
export function changeDirection(change: PeriodChange): 'up' | 'down' | 'flat' | 'none' {
  switch (change.kind) {
    case 'unknown':
      return 'none';
    case 'new':
    case 'almost_new':
      return 'up';
    case 'much_less':
      return 'down';
    case 'percent':
      return Math.abs(change.value) < 0.05 ? 'flat' : change.value > 0 ? 'up' : 'down';
  }
}

/** Подпись под плиткой. `points` — доля: изменение в процентных пунктах, словами не заменяется. */
export function changeText(change: PeriodChange, points = false): string {
  switch (change.kind) {
    case 'unknown':
      return 'нет данных для сравнения';
    case 'new':
      return 'раньше не было';
    case 'almost_new':
      return 'раньше почти не было';
    case 'much_less':
      return 'намного меньше, чем раньше';
    case 'percent': {
      if (Math.abs(change.value) < 0.05) return 'без изменений';
      const sign = change.value > 0 ? '+' : '';
      const number = change.value.toFixed(1).replace('.', ',');
      return `${sign}${number} ${points ? 'п. п.' : '%'} к прошлому периоду`;
    }
  }
}
