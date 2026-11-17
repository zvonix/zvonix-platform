import { describe, expect, it } from 'vitest';
import type { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';
import { MAX_RANGE_DAYS, overviewQuerySchema } from './schemas.js';

const service = new ReportsService({} as ReportsRepository);

describe('период сводки', () => {
  it('сутки from…to по местным часам: Красноярск (+7) начинает 1 ноября в 17:00 UTC 31 октября', () => {
    const window = service.window({ days: 7, from: '2026-11-01', to: '2026-11-03' }, 420);
    expect(window.days).toBe(3);
    expect(window.from.toISOString()).toBe('2026-10-31T17:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-11-03T17:00:00.000Z');
  });

  it('без дат — прежние «последние N дней»: старый кабинет получает то же, что раньше', () => {
    const window = service.window({ days: 7 }, 0);
    expect(window.days).toBe(7);
    expect(window.to.getTime() - window.from.getTime()).toBe(7 * 86_400_000);
  });

  it('схема: одна дата, перевёрнутый, длиннее года или несуществующий день — отказ', () => {
    const parse = (query: Record<string, string>) => overviewQuerySchema.safeParse(query).success;
    expect(parse({ from: '2026-11-01', to: '2026-11-01' })).toBe(true);
    expect(parse({ from: '2026-11-01' })).toBe(false);
    expect(parse({ from: '2026-11-03', to: '2026-11-01' })).toBe(false);
    expect(parse({ from: '2026-02-29', to: '2026-03-01' })).toBe(false);
    expect(parse({ from: '2025-11-01', to: '2026-11-01' })).toBe(true);
    expect(MAX_RANGE_DAYS).toBe(366);
    expect(parse({ from: '2025-10-31', to: '2026-11-01' })).toBe(false);
  });
});
