/**
 * Период отчёта в адресе запроса: «последние N суток» (`days`) или свои сутки `from`…`to`
 * включительно по часам человека (`offset`, минуты к востоку от UTC). Один разбор на все отчёты
 * и графики кабинета ([ADR-0059](../../../../docs/adr/0059-otchyoty-i-svodki.md), ревизия 2026-11-17).
 */

import { z } from 'zod';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Самый длинный свой период: год с запасом на високосный. */
export const MAX_RANGE_DAYS = 366;

/** Смещение часового пояса браузера в минутах к востоку от UTC (Красноярск — 420). */
export const offsetField = z
  .string()
  .optional()
  .transform((raw) => Number(raw ?? '0'))
  .pipe(z.number().int().min(-720).max(840));

/** Местные сутки `ГГГГ-ММ-ДД`; несуществующая дата (31 февраля) — отказ, а не перенос на март. */
const dayField = z
  .string()
  .regex(/^20[2-9]\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u, 'ожидается дата вида 2026-11-17')
  .refine(
    (value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
    'такой даты нет',
  )
  .optional();

/** Поля своего периода; `days` у каждого отчёта свои (набор и умолчание). */
export const rangeFields = { from: dayField, to: dayField, offset: offsetField };

/** Сутки между датами включительно: `2026-11-01`…`2026-11-01` — одни. */
const daysBetween = (first: string, last: string): number =>
  Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS) + 1;

/** Проверка пары дат для `superRefine`: обе сразу, по порядку, не длиннее `MAX_RANGE_DAYS`. */
export const checkRange = (
  query: { from?: string | undefined; to?: string | undefined },
  context: z.RefinementCtx,
): void => {
  if ((query.from === undefined) !== (query.to === undefined)) {
    context.addIssue({ code: 'custom', message: 'нужны обе даты: from и to', path: ['to'] });
    return;
  }
  if (query.from === undefined || query.to === undefined) return;
  const span = daysBetween(query.from, query.to);
  if (span < 1) {
    context.addIssue({ code: 'custom', message: 'начало позже конца', path: ['from'] });
  } else if (span > MAX_RANGE_DAYS) {
    context.addIssue({
      code: 'custom',
      message: `период длиннее ${String(MAX_RANGE_DAYS)} дней`,
      path: ['to'],
    });
  }
};

/** Период из запроса: последние `days` суток или сутки `from`…`to`. */
export interface PeriodQuery {
  readonly days: number;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly offset: number;
}

/** Границы периода: `[from, to)`, длина в сутках. Сутки — местные, как их видит человек. */
export interface PeriodWindow {
  readonly from: Date;
  readonly to: Date;
  readonly days: number;
}

/**
 * Границы периода. Последние `days` суток включают сегодняшние: «7 дней» — шесть полных и
 * сегодня до конца суток. Свои даты — с полуночи `from` до полуночи после `to` по местным часам.
 */
export function periodWindow(query: PeriodQuery, now = new Date()): PeriodWindow {
  const shift = query.offset * MINUTE_MS;
  if (query.from !== undefined && query.to !== undefined) {
    return {
      from: new Date(Date.parse(`${query.from}T00:00:00Z`) - shift),
      to: new Date(Date.parse(`${query.to}T00:00:00Z`) + DAY_MS - shift),
      days: daysBetween(query.from, query.to),
    };
  }
  const today = Math.floor((now.getTime() + shift) / DAY_MS) * DAY_MS;
  return {
    from: new Date(today - (query.days - 1) * DAY_MS - shift),
    to: new Date(today + DAY_MS - shift),
    days: query.days,
  };
}

/** Местные сутки периода по порядку: подписи ряда, пустые дни — тоже. */
export function periodDays(window: PeriodWindow, offsetMinutes: number): string[] {
  return Array.from({ length: window.days }, (_unused, index) =>
    new Date(window.from.getTime() + index * DAY_MS + offsetMinutes * MINUTE_MS)
      .toISOString()
      .slice(0, 10),
  );
}
