import { z } from 'zod';
import { checkRange, offsetField, rangeFields } from '../../http/period.js';
import { DIMENSIONS } from './reports.repository.js';

/** Быстрые периоды сводки: «сегодня», неделя, месяц, квартал. */
const REPORT_DAYS = [1, 7, 30, 90] as const;

const days = z
  .string()
  .optional()
  .transform((raw) => Number(raw ?? '7'))
  .pipe(z.union(REPORT_DAYS.map((value) => z.literal(value)) as [z.ZodLiteral<number>]));

/**
 * Период сводки: «последние N дней» (`days`) или свои сутки `from`…`to` включительно.
 * Даты сильнее `days`: старый кабинет шлёт только `days` и получает то же, что раньше.
 */
const range = { days, ...rangeFields };

/** Месяц акта: `ГГГГ-ММ`, не старше 2020 года — раньше площадки не было. */
export const statementQuerySchema = z.object({
  month: z.string().regex(/^20[2-9]\d-(0[1-9]|1[0-2])$/u, 'ожидается месяц вида 2026-09'),
  offset: offsetField,
});

export const overviewQuerySchema = z.object(range).superRefine(checkRange);

export const breakdownQuerySchema = z
  .object({ ...range, by: z.enum(DIMENSIONS) })
  .superRefine(checkRange);
