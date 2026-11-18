import { fromIsoDay, isoDay, periodMoments, REPORT_PERIODS, type ReportPeriod } from './reports';

/**
 * Период в отборе списков — вызовы, журнал действий, журнал сообщений. Выбирается тем же `PeriodPicker`, что
 * и в сводках: быстрыми кнопками и своим диапазоном целых суток. Раньше здесь стояли родные поля даты и времени
 * «С/По» с минутами — по ним никто не искал, а выглядели они по-разному в каждом браузере (владелец, 2026-11-18).
 *
 * Сверх сводок у списков есть «Всё время» — без отбора и по умолчанию, — а у разбора вызовов ещё «Час» и «Сутки»:
 * последние 60 минут и 24 часа, а не календарные «Сегодня» (инцидент в 00:30 иначе неудобно смотреть).
 *
 * В адресе: `period=all|1h|24h|<сутки>` или свой диапазон `from=ГГГГ-ММ-ДД&to=ГГГГ-ММ-ДД`. API по-прежнему получает
 * моменты `from`/`to` (`listPeriodSearch`). Старые ссылки и сохранённые наборы с моментами `from`/`to` читаются как
 * сутки этих моментов и не ломаются.
 */
export type ListPeriod =
  | { readonly all: true }
  /** Последние N часов — от «сейчас». */
  | { readonly hours: number }
  | ReportPeriod;

/** Быстрые кнопки: ключ в адресе (`period=…`) и подписи. */
export interface QuickPeriod {
  readonly key: string;
  readonly label: string;
  readonly short: string;
}

const ALL: QuickPeriod = { key: 'all', label: 'Всё время', short: 'Всё' };
const HOUR: QuickPeriod = { key: '1h', label: 'Час', short: 'Час' };
const DAY: QuickPeriod = { key: '24h', label: 'Сутки', short: 'Сутки' };
const DAYS: readonly QuickPeriod[] = REPORT_PERIODS.map((period) => ({
  key: String(period.days),
  label: period.label,
  short: period.short,
}));

/** Кнопки обычного списка: «Всё время» первым, затем те же, что в сводках. */
export const LIST_PERIODS: readonly QuickPeriod[] = [ALL, ...DAYS];

/** Кнопки разбора вызовов: «Час» и «Сутки» вместо календарного «Сегодня». */
export const INCIDENT_PERIODS: readonly QuickPeriod[] = [
  ALL,
  HOUR,
  DAY,
  ...DAYS.filter((period) => period.key !== '1'),
];

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** Ключ быстрой кнопки для периода; свой диапазон — `null`. */
export function quickKey(period: ListPeriod): string | null {
  if ('all' in period) return ALL.key;
  if ('hours' in period) return `${String(period.hours)}h`;
  if ('days' in period) return String(period.days);
  return null;
}

/** Период по ключу кнопки. */
export function fromQuickKey(key: string): ListPeriod {
  if (key === ALL.key) return { all: true };
  const hours = /^(\d+)h$/u.exec(key);
  if (hours !== null) return { hours: Number(hours[1]) };
  const days = Number(key);
  return Number.isInteger(days) && days > 0 ? { days } : { all: true };
}

/** Местные сутки момента: старые ссылки хранили границы моментами (`2026-11-17T04:00:00.000Z`). */
function dayOf(value: string): string | undefined {
  if (DAY_PATTERN.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : isoDay(parsed);
}

/** Период из адреса страницы. Нет ни `period`, ни `from`/`to` — «Всё время». */
export function readListPeriod(get: (key: string) => string): ListPeriod {
  const key = get('period');
  if (key !== '') return fromQuickKey(key);
  const from = dayOf(get('from'));
  const to = dayOf(get('to'));
  if (from === undefined && to === undefined) return { all: true };
  const today = isoDay(new Date());
  const end = to ?? today;
  // Старая ссылка только с «По» — с года до этой даты: так длинен самый широкий свой период.
  const start = from ?? isoDay(new Date(fromIsoDay(end).getTime() - 365 * 86_400_000));
  return start <= end ? { from: start, to: end } : { from: end, to: start };
}

/** Что записать в адрес: прежние `from`/`to`/`period` заменяются целиком. */
export function listPeriodParams(period: ListPeriod): Record<string, string> {
  const key = quickKey(period);
  if (key !== null) return { period: key === ALL.key ? '' : key, from: '', to: '' };
  const { from, to } = period as { from: string; to: string };
  return { period: '', from, to };
}

/** Начало текущей минуты. */
function currentMinute(): Date {
  return new Date(Math.floor(Date.now() / 60_000) * 60_000);
}

/** Границы периода моментами для API; пусто — без границы. */
export function listPeriodMoments(
  period: ListPeriod,
  now = new Date(),
): { from: string; to: string } {
  if ('all' in period) return { from: '', to: '' };
  if ('hours' in period) {
    return { from: new Date(now.getTime() - period.hours * 3_600_000).toISOString(), to: '' };
  }
  return periodMoments(period);
}

/**
 * Запрос к API из адреса страницы: `period` и сутки свои — в моменты `from`/`to`, остальные отборы как есть.
 * Часы считаются от текущей минуты: от точного «сейчас» запрос менялся бы на каждой отрисовке, и список
 * перечитывался бы без конца. Минута — то же окно, что у быстрой кнопки «час» прежде.
 */
export function listPeriodSearch(query: string, now = currentMinute()): URLSearchParams {
  const search = new URLSearchParams(query);
  const period = readListPeriod((key) => search.get(key) ?? '');
  search.delete('period');
  search.delete('from');
  search.delete('to');
  const { from, to } = listPeriodMoments(period, now);
  if (from !== '') search.set('from', from);
  if (to !== '') search.set('to', to);
  return search;
}
