import { describe, expect, it } from 'vitest';
import {
  CALL_WARMUP_DAYS,
  CALL_WARMUP_IDLE_DAYS,
  callPace,
  callWarmupDailyLimit,
  callWarmupDay,
} from './call-pace.js';

const DAY = 86_400_000;
const now = new Date('2026-10-29T12:00:00Z');
const ago = (days: number): Date => new Date(now.getTime() - days * DAY);

describe('прогрев номера', () => {
  it('неделя — 10…60, к 14-м суткам — потолок, кривая не убывает и не выше потолка', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((day) => callWarmupDailyLimit(day, 150))).toEqual([
      10, 15, 20, 30, 40, 50, 60,
    ]);
    let previous = 0;
    for (let day = 0; day <= CALL_WARMUP_DAYS + 2; day += 1) {
      const limit = callWarmupDailyLimit(day, 150);
      expect(limit).toBeGreaterThanOrEqual(previous);
      expect(limit).toBeLessThanOrEqual(150);
      previous = limit;
    }
    expect(callWarmupDailyLimit(CALL_WARMUP_DAYS, 150)).toBe(150);
    // Потолок ниже кривой режет и прогрев.
    expect(callWarmupDailyLimit(5, 25)).toBe(25);
  });

  it('новый номер — без попыток за 14 суток; звонивший без отметки — прогретый', () => {
    expect(callWarmupDay(null, null, now)).toBe(0);
    expect(callWarmupDay(ago(30), ago(CALL_WARMUP_IDLE_DAYS), now)).toBe(0);
    expect(callWarmupDay(null, ago(1), now)).toBeNull();
    expect(callWarmupDay(ago(3.5), ago(0.1), now)).toBe(3);
    expect(callWarmupDay(ago(CALL_WARMUP_DAYS), ago(0.1), now)).toBeNull();
  });

  it('пределы: рекомендованные после прогрева, тройная доля при прогреве, × число номеров транка', () => {
    const settings = { warmupEnabled: true, perHour: 20, perDay: 150 };
    expect(callPace(settings, null)).toEqual({ perHour: 20, perDay: 150, warmupDay: null });
    expect(callPace(settings, 0)).toEqual({ perHour: 2, perDay: 10, warmupDay: 0 });
    expect(callPace(settings, 6)).toEqual({ perHour: 8, perDay: 60, warmupDay: 6 });
    expect(callPace(settings, 0, 5)).toEqual({ perHour: 10, perDay: 50, warmupDay: 0 });
    expect(callPace({ ...settings, warmupEnabled: false }, 0)).toEqual({
      perHour: 20,
      perDay: 150,
      warmupDay: null,
    });
    expect(callPace({ warmupEnabled: false, perHour: 0, perDay: 0 }, null)).toEqual({
      perHour: null,
      perDay: null,
      warmupDay: null,
    });
    // Без рекомендованного «в сутки» прогрев растёт к запасному потолку, час — по доле.
    expect(callPace({ warmupEnabled: true, perHour: 0, perDay: 0 }, 0)).toEqual({
      perHour: 2,
      perDay: 10,
      warmupDay: 0,
    });
  });
});
