import { z } from 'zod';
import { DIMENSIONS } from './reports.repository.js';

/** Периоды сводки: «сегодня», неделя, месяц, квартал. */
const REPORT_DAYS = [1, 7, 30, 90] as const;

/** Самый длинный произвольный период: год с запасом на високосный. */
export const MAX_RANGE_DAYS = 366;

const DAY_MS = 86_400_000;

const days = z
  .string()
  .optional()
  .transform((raw) => Number(raw ?? '7'))
  .pipe(z.union(REPORT_DAYS.map((value) => z.literal(value)) as [z.ZodLiteral<number>]));

/** Смещение часового пояса браузера в минутах к востоку от UTC (Красноярск — 420). */
const offset = z
  .string()
  .optional()
  .transform((raw) => Number(raw ?? '0'))
  .pipe(z.number().int().min(-720).max(840));

/** Местные сутки `ГГГГ-ММ-ДД`; несуществующая дата (31 февраля) — отказ, а не перенос на март. */
const day = z
  .string()
  .regex(/^20[2-9]\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u, 'ожидается дата вида 2026-11-17')
  .refine(
    (value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
    'такой даты нет',
  )
  .optional();

/** Сутки между датами включительно: `2026-11-01`…`2026-11-01` — одни. */
export const daysBetween = (first: string, last: string): number =>
  Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS) + 1;

/**
 * Период сводки: «последние N дней» (`days`) или произвольные сутки `from`…`to` включительно.
 * Даты сильнее `days`: старый кабинет шлёт только `days` и получает то же, что раньше.
 */
const range = {
  days,
  offset,
  from: day,
  to: day,
};

const checkRange = (
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

/** Месяц акта: `ГГГГ-ММ`, не старше 2020 года — раньше площадки не было. */
export const statementQuerySchema = z.object({
  month: z.string().regex(/^20[2-9]\d-(0[1-9]|1[0-2])$/u, 'ожидается месяц вида 2026-09'),
  offset,
});

export const overviewQuerySchema = z.object(range).superRefine(checkRange);

export const breakdownQuerySchema = z
  .object({ ...range, by: z.enum(DIMENSIONS) })
  .superRefine(checkRange);
