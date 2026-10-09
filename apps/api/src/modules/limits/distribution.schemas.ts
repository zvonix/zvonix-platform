import {
  DISTRIBUTION_MODES,
  DISTRIBUTION_RANK_MAX,
  DISTRIBUTION_RESERVE_MAX,
} from '@zvonix/shared';
import { z } from 'zod';

const minuteOfDay = z.number().int('должно быть целым числом').min(0).max(1439);

/**
 * Настройка распределения партнёра ([ADR-0080](../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)).
 * Тихие часы — обе границы или ни одной; пояс — название из базы часовых поясов.
 */
export const distributionSchema = z
  .object({
    mode: z.enum(DISTRIBUTION_MODES),
    reservePercent: z.number().int('должно быть целым числом').min(0).max(DISTRIBUTION_RESERVE_MAX),
    quietFromMinute: minuteOfDay.nullable(),
    quietToMinute: minuteOfDay.nullable(),
    timezone: z
      .string()
      .trim()
      .min(1, 'укажите пояс')
      .max(64)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, 'неизвестный часовой пояс'),
    stickyRecipient: z.boolean(),
  })
  .refine((body) => (body.quietFromMinute === null) === (body.quietToMinute === null), {
    message: 'Тихие часы — начало и конец вместе',
  })
  .refine((body) => body.quietFromMinute === null || body.quietFromMinute !== body.quietToMinute, {
    message: 'Начало и конец тихих часов не должны совпадать',
  });

/** Вес и приоритет аккаунта в распределении; что не названо — не меняется. */
export const rankSchema = z
  .object({
    weight: z.number().int().min(1).max(DISTRIBUTION_RANK_MAX).optional(),
    priority: z.number().int().min(1).max(DISTRIBUTION_RANK_MAX).optional(),
  })
  .refine((body) => body.weight !== undefined || body.priority !== undefined, {
    message: 'Нечего менять',
  });
