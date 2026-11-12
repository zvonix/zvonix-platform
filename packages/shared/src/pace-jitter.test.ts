import { describe, expect, it } from 'vitest';
import { variedDailyLimit } from './pace-jitter.js';

describe('разный суточный предел по дням (ADR-0116)', () => {
  const noon = (day: number) => new Date(Date.UTC(2026, 10, day, 9, 0));

  it('предел дня — от (100 − доля) % до настроенного, верх не превышается', () => {
    const seen = new Set<number>();
    for (let day = 1; day <= 30; day += 1) {
      for (const key of ['sim-a', 'sim-b', 'sim-c']) {
        const limit = variedDailyLimit(100, key, noon(day), 30);
        expect(limit).toBeGreaterThanOrEqual(70);
        expect(limit).toBeLessThanOrEqual(100);
        seen.add(limit);
      }
    }
    // Не одно число: за месяц у трёх номеров пределы разные.
    expect(seen.size).toBeGreaterThan(10);
  });

  it('в течение дня по Москве число одно и то же, на следующий день — своё', () => {
    const morning = new Date('2026-11-12T00:30:00+03:00');
    const evening = new Date('2026-11-12T23:30:00+03:00');
    expect(variedDailyLimit(100, 'sim-a', morning, 30)).toBe(
      variedDailyLimit(100, 'sim-a', evening, 30),
    );
    const days = new Set(
      [12, 13, 14, 15, 16, 17, 18].map((day) =>
        variedDailyLimit(100, 'sim-a', new Date(`2026-11-${String(day)}T12:00:00+03:00`), 30),
      ),
    );
    expect(days.size).toBeGreaterThan(1);
  });

  it('у разных номеров в один день — разные пределы', () => {
    const values = new Set(
      Array.from({ length: 20 }, (_, index) =>
        variedDailyLimit(100, `sim-${String(index)}`, noon(12), 30),
      ),
    );
    expect(values.size).toBeGreaterThan(5);
  });

  it('0 % — как прежде; ноль остаётся нулём; положительный не ниже 1', () => {
    expect(variedDailyLimit(100, 'sim-a', noon(12), 0)).toBe(100);
    expect(variedDailyLimit(0, 'sim-a', noon(12), 30)).toBe(0);
    for (let day = 1; day <= 30; day += 1) {
      expect(variedDailyLimit(1, 'sim-a', noon(day), 90)).toBe(1);
    }
  });

  it('доля больше 90 % не берётся', () => {
    for (let day = 1; day <= 30; day += 1) {
      expect(variedDailyLimit(100, 'sim-a', noon(day), 500)).toBeGreaterThanOrEqual(10);
    }
  });
});
