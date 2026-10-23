import { describe, expect, it } from 'vitest';
import {
  spreadHourlyLimit,
  WARMUP_DAYS,
  WARMUP_SECOND_WEEK_LIMIT,
  warmupDailyLimit,
} from './messaging.js';

describe('прогрев аккаунта', () => {
  it('сутки 0 — ничего, неделя — 3, 5, 8, 12; 14-е — 40; дальше линейно, с 29-х суток — потолок', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((day) => warmupDailyLimit(day, 500))).toEqual([
      0, 3, 5, 8, 12, 12, 12,
    ]);
    expect(warmupDailyLimit(13, 500)).toBe(WARMUP_SECOND_WEEK_LIMIT);
    // Прежняя кривая на 5-е сутки давала 71 — столько было у ограниченного аккаунта (владелец, 2026-10-23).
    expect(warmupDailyLimit(4, 80)).toBeLessThanOrEqual(12);
    expect(warmupDailyLimit(17, 500)).toBeGreaterThan(WARMUP_SECOND_WEEK_LIMIT);
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

  it('малый потолок режет и прогрев; сутки 0 — ноль при любом потолке', () => {
    expect(warmupDailyLimit(0, 5)).toBe(0);
    expect(warmupDailyLimit(3, 5)).toBe(5);
    expect(warmupDailyLimit(10, 5)).toBe(5);
    expect(warmupDailyLimit(1, 1)).toBe(1);
  });

  it('часовая доля — двойная средняя, не меньше одного в час', () => {
    expect(spreadHourlyLimit(12)).toBe(1);
    expect(spreadHourlyLimit(100)).toBe(9);
    expect(spreadHourlyLimit(500)).toBe(42);
    expect(spreadHourlyLimit(1)).toBe(1);
  });
});
