import { describe, expect, it } from 'vitest';
import {
  spreadHourlyLimit,
  WARMUP_DAYS,
  WARMUP_FIRST_DAY_LIMIT,
  WARMUP_WEEK_LIMIT,
  warmupDailyLimit,
} from './messaging.js';

describe('прогрев аккаунта', () => {
  it('первые сутки — 12, на седьмые — 100, дальше растёт линейно и с 29-х суток равен потолку', () => {
    expect(warmupDailyLimit(0, 500)).toBe(WARMUP_FIRST_DAY_LIMIT);
    expect(warmupDailyLimit(6, 500)).toBe(WARMUP_WEEK_LIMIT);
    expect(warmupDailyLimit(17, 500)).toBeGreaterThan(WARMUP_WEEK_LIMIT);
    expect(warmupDailyLimit(17, 500)).toBeLessThan(500);
    expect(warmupDailyLimit(WARMUP_DAYS - 1, 500)).toBeLessThanOrEqual(500);
    expect(warmupDailyLimit(WARMUP_DAYS, 500)).toBe(500);
  });

  it('лимит не убывает по дням и не выше потолка тарифа', () => {
    let previous = 0;
    for (let day = 0; day <= WARMUP_DAYS + 3; day += 1) {
      const limit = warmupDailyLimit(day, 300);
      expect(limit).toBeGreaterThanOrEqual(previous);
      expect(limit).toBeLessThanOrEqual(300);
      previous = limit;
    }
  });

  it('малый потолок режет и первую неделю; всегда не меньше одного', () => {
    expect(warmupDailyLimit(0, 5)).toBe(5);
    expect(warmupDailyLimit(10, 5)).toBe(5);
    expect(warmupDailyLimit(0, 1)).toBe(1);
  });

  it('часовая доля — двойная средняя, не меньше одного в час', () => {
    expect(spreadHourlyLimit(12)).toBe(1);
    expect(spreadHourlyLimit(100)).toBe(9);
    expect(spreadHourlyLimit(500)).toBe(42);
    expect(spreadHourlyLimit(1)).toBe(1);
  });
});
