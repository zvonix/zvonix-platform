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

/** Месяц акта: `ГГГГ-ММ`, не старше 2020 года — раньше площадки не было. */
export const statementQuerySchema = z.object({
  month: z.string().regex(/^20[2-9]\d-(0[1-9]|1[0-2])$/u, 'ожидается месяц вида 2026-09'),
  offset,
});

export const overviewQuerySchema = z.object({ days, offset });

export const breakdownQuerySchema = z.object({
  days,
  offset,
  by: z.enum(DIMENSIONS),
});
