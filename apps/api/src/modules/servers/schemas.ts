import { z } from 'zod';
import { checkRange, rangeFields } from '../../http/period.js';

const megabytes = z.number().int('должно быть целым числом').min(0).max(1_000_000_000);

/** Замер, который присылает узел ([ADR-0065](../../../../../docs/adr/0065-sostoyanie-serverov-i-istoriya.md)). */
export const nodeMetricsSchema = z.object({
  /** Средняя нагрузка за минуту, как её показывает `/proc/loadavg`. */
  load1: z.number().min(0).max(100_000),
  cpuCores: z.number().int('должно быть целым числом').min(1).max(4096),
  memTotalMb: megabytes,
  memAvailableMb: megabytes,
  diskTotalMb: megabytes,
  diskFreeMb: megabytes,
  activeCalls: z.number().int('должно быть целым числом').min(0).max(100_000).optional(),
});

/**
 * Окно истории: быстрое (`range`: hour, day, week) или свои сутки `from`…`to` по часам человека — тот же выбор периода,
 * что у отчётов (ADR-0059, ревизия 2026-11-17). Даты сильнее `range`.
 */
export const serversQuerySchema = z
  .object({
    range: z.enum(['hour', 'day', 'week']).default('day'),
    ...rangeFields,
  })
  .superRefine(checkRange);
