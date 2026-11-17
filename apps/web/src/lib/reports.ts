'use client';

import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { request } from './api';
import { useLiveInterval } from './live';

/** Что считается у любой роли; суммы у каждой свои (ADR-0059). */
export interface ReportRow {
  readonly calls: number;
  readonly answered: number;
  readonly talk_seconds: number;
  /** Сотрудникам: списано с клиентов. */
  readonly revenue?: string;
  readonly partner_cost?: string;
  readonly margin?: string;
  /** Клиенту: потрачено. */
  readonly spent?: string;
  /** Партнёру: заработано. */
  readonly earned?: string;
  /** Сообщения MAX: принято к отправке и доставлено (или прочитано). */
  readonly messages: number;
  readonly messages_delivered: number;
  readonly messages_read: number;
  readonly message_revenue?: string;
  readonly message_partner_cost?: string;
  readonly message_margin?: string;
  readonly message_spent?: string;
  readonly message_earned?: string;
}

export type MoneyKey =
  | 'revenue'
  | 'partner_cost'
  | 'margin'
  | 'spent'
  | 'earned'
  | 'message_revenue'
  | 'message_partner_cost'
  | 'message_margin'
  | 'message_spent'
  | 'message_earned';

/** Звонки или сообщения MAX: сводка показывает одно из двух, итог — оба. */
export type ReportProduct = 'calls' | 'messages';

export interface Overview {
  readonly days: number;
  /** Плата за бота за период: клиенту — потрачено, площадке — получено; партнёру её нет. */
  readonly bot_fees?: string;
  readonly totals: ReportRow;
  readonly series: readonly (ReportRow & { readonly day: string })[];
}

export interface Breakdown {
  readonly rows: readonly (ReportRow & {
    readonly key: string | null;
    readonly name: string | null;
  })[];
}

/** Быстрые периоды — одни во всех выборах периода (владелец, 2026-11-17: «30, 60, 90 и т. д.»). */
export const REPORT_PERIODS = [
  { days: 1, label: 'Сегодня' },
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 60, label: '60 дней' },
  { days: 90, label: '90 дней' },
  { days: 365, label: 'Год' },
] as const;

/** Минуты к востоку от UTC: сутки в сводке считаются по часам человека, а не сервера. */
const offsetMinutes = (): number => -new Date().getTimezoneOffset();

/**
 * Период сводки: быстрый — последние N суток — или свой, сутки `from`…`to` включительно
 * по часам человека (ADR-0059, ревизия 2026-11-17).
 */
export type ReportPeriod =
  { readonly days: number } | { readonly from: string; readonly to: string };

const pad = (value: number): string => String(value).padStart(2, '0');

/** Местные сутки `ГГГГ-ММ-ДД` — так их ждёт API. */
export const isoDay = (date: Date): string =>
  `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** `ГГГГ-ММ-ДД` → местная полночь. */
export const fromIsoDay = (day: string): Date => {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(year, month - 1, date);
};

const addDays = (day: string, delta: number): string => {
  const date = fromIsoDay(day);
  date.setDate(date.getDate() + delta);
  return isoDay(date);
};

/** Первые и последние местные сутки периода: у быстрого — последние N, сегодня включительно. */
export function periodBounds(period: ReportPeriod): { from: string; to: string } {
  if (!('days' in period)) return period;
  const today = isoDay(new Date());
  return { from: addDays(today, 1 - Math.max(1, Math.round(period.days))), to: today };
}

/** Период той же длины сразу перед данным — с чем сравнивать «стало». */
export function previousPeriod(period: ReportPeriod): { from: string; to: string } {
  const { from, to } = periodBounds(period);
  const length =
    Math.round((fromIsoDay(to).getTime() - fromIsoDay(from).getTime()) / 86_400_000) + 1;
  return { from: addDays(from, -length), to: addDays(from, -1) };
}

/** Границы периода моментами `[from, to)` — для API, которые принимают время, а не сутки. */
export function periodMoments(period: ReportPeriod): { from: string; to: string } {
  const { from, to } = periodBounds(period);
  return { from: fromIsoDay(from).toISOString(), to: fromIsoDay(addDays(to, 1)).toISOString() };
}

/** Ключ кэша: два одинаковых периода — один запрос. */
export const periodKey = (period: ReportPeriod): string =>
  'days' in period ? String(period.days) : `${period.from}..${period.to}`;

/** Часть адреса API с периодом и часовым поясом: `days=7&offset=420` или `from=…&to=…&offset=420`. */
export const periodQuery = (period: ReportPeriod): string =>
  `${'days' in period ? `days=${String(period.days)}` : `from=${period.from}&to=${period.to}`}&offset=${String(offsetMinutes())}`;

export function useOverview(base: string, period: ReportPeriod): UseQueryResult<Overview> {
  const live = useLiveInterval();
  return useQuery({
    queryKey: ['report', base, 'overview', periodKey(period)],
    queryFn: () => request<Overview>(`${base}/overview?${periodQuery(period)}`),
    refetchInterval: live,
    // Пока грузится новый период, на экране остаётся прежний: без мигания и прыжка раскладки.
    placeholderData: keepPreviousData,
  });
}

export function useBreakdown(
  base: string,
  period: ReportPeriod,
  by: string,
): UseQueryResult<Breakdown> {
  const live = useLiveInterval();
  return useQuery({
    queryKey: ['report', base, 'breakdown', periodKey(period), by],
    queryFn: () => request<Breakdown>(`${base}/breakdown?${periodQuery(period)}&by=${by}`),
    refetchInterval: live,
  });
}

/** Доля состоявшихся; `undefined`, пока вызовов не было, — делить не на что. */
export function asr(row: ReportRow): number | undefined {
  return row.calls === 0 ? undefined : (row.answered / row.calls) * 100;
}

/** Средняя длительность состоявшегося, секунды. */
export function acd(row: ReportRow): number | undefined {
  return row.answered === 0 ? undefined : Math.round(row.talk_seconds / row.answered);
}

/** Доля доставленных сообщений; `undefined`, пока сообщений не было. */
export function deliveredShare(row: ReportRow): number | undefined {
  return row.messages === 0 ? undefined : (row.messages_delivered / row.messages) * 100;
}

/** Доля прочитанных среди доставленных: доходят ли отметки о прочтении. */
export function readShare(row: ReportRow): number | undefined {
  return row.messages_delivered === 0
    ? undefined
    : (row.messages_read / row.messages_delivered) * 100;
}

/** Число для высоты столбца — не для денег: показывается всегда строка API. */
export const asNumber = (value: string | undefined): number => Number(value ?? '0');
