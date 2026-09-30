'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
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
}

export type MoneyKey = 'revenue' | 'partner_cost' | 'margin' | 'spent' | 'earned';

export interface Overview {
  readonly days: number;
  readonly totals: ReportRow;
  readonly series: readonly (ReportRow & { readonly day: string })[];
}

export interface Breakdown {
  readonly rows: readonly (ReportRow & {
    readonly key: string | null;
    readonly name: string | null;
  })[];
}

export const REPORT_PERIODS = [
  { days: 1, label: 'Сегодня' },
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' },
] as const;

/** Минуты к востоку от UTC: сутки в сводке считаются по часам человека, а не сервера. */
const offsetMinutes = (): number => -new Date().getTimezoneOffset();

export function useOverview(base: string, days: number): UseQueryResult<Overview> {
  const live = useLiveInterval();
  return useQuery({
    queryKey: ['report', base, 'overview', days],
    queryFn: () =>
      request<Overview>(`${base}/overview?days=${String(days)}&offset=${String(offsetMinutes())}`),
    refetchInterval: live,
  });
}

export function useBreakdown(base: string, days: number, by: string): UseQueryResult<Breakdown> {
  const live = useLiveInterval();
  return useQuery({
    queryKey: ['report', base, 'breakdown', days, by],
    queryFn: () =>
      request<Breakdown>(
        `${base}/breakdown?days=${String(days)}&offset=${String(offsetMinutes())}&by=${by}`,
      ),
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

/** Число для высоты столбца — не для денег: показывается всегда строка API. */
export const asNumber = (value: string | undefined): number => Number(value ?? '0');
