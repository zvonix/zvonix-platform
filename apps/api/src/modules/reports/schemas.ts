import { z } from 'zod';
import { DIMENSIONS } from './reports.repository.js';

/** Периоды сводки: «сегодня», неделя, месяц, квартал. */
const REPORT_DAYS = [1, 7, 30, 90] as const;

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

export const overviewQuerySchema = z.object({ days, offset });

export const breakdownQuerySchema = z.object({
  days,
  offset,
  by: z.enum(DIMENSIONS),
});
