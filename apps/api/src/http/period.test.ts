import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { overviewQuerySchema } from '../modules/reports/schemas.js';
import { checkRange, MAX_RANGE_DAYS, periodDays, periodWindow, rangeFields } from './period.js';

describe('период отчёта', () => {
  it('сутки from…to по местным часам: Красноярск (+7) начинает 1 ноября в 17:00 UTC 31 октября', () => {
    const window = periodWindow({ days: 7, from: '2026-11-01', to: '2026-11-03', offset: 420 });
    expect(window.days).toBe(3);
    expect(window.from.toISOString()).toBe('2026-10-31T17:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-11-03T17:00:00.000Z');
    expect(periodDays(window, 420)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
  });

  it('без дат — последние N суток, сегодняшние включительно', () => {
    const now = new Date('2026-11-17T10:00:00Z');
    const window = periodWindow({ days: 7, offset: 0 }, now);
    expect(window.from.toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-11-18T00:00:00.000Z');
    expect(periodDays(window, 0).at(-1)).toBe('2026-11-17');
  });

  it('проверка: одна дата, перевёрнутый, длиннее года или несуществующий день — отказ', () => {
    const schema = z.object(rangeFields).superRefine(checkRange);
    const parse = (query: Record<string, string>) => schema.safeParse(query).success;
    expect(parse({ from: '2026-11-01', to: '2026-11-01' })).toBe(true);
    expect(parse({ from: '2026-11-01' })).toBe(false);
    expect(parse({ from: '2026-11-03', to: '2026-11-01' })).toBe(false);
    expect(parse({ from: '2026-02-29', to: '2026-03-01' })).toBe(false);
    expect(MAX_RANGE_DAYS).toBe(366);
    expect(parse({ from: '2025-11-01', to: '2026-11-01' })).toBe(true);
    expect(parse({ from: '2025-10-31', to: '2026-11-01' })).toBe(false);
  });

  it('сводка: быстрые периоды прежние, даты сильнее days', () => {
    expect(overviewQuerySchema.safeParse({ days: '14' }).success).toBe(false);
    expect(
      overviewQuerySchema.parse({ days: '30', from: '2026-11-01', to: '2026-11-02' }),
    ).toMatchObject({
      days: 30,
      from: '2026-11-01',
    });
  });
});
