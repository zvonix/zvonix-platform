import { describe, expect, it } from 'vitest';
import {
  CALL_WARMUP_DAYS,
  CALL_WARMUP_IDLE_DAYS,
  callPace,
  callRestingUntil,
  callRestWindowMs,
  callWarmupDailyLimit,
  callWarmupDay,
  isPoorNumber,
} from './call-pace.js';
import { jitteredPauseMs, paceJitter, sleepUntil } from './pace-jitter.js';

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
    const settings = {
      warmupEnabled: true,
      perHour: 20,
      perDay: 150,
      pauseSeconds: 30,
      warmupPauseSeconds: 90,
      distinctPerHour: 15,
      distinctPerDay: 100,
      sleepHours: 0,
      poorAnswerPercent: 0,
    };
    const common = { numbers: 1, poor: false, distinctPerHour: 15, distinctPerDay: 100 };
    expect(callPace(settings, null)).toEqual({
      ...common,
      perHour: 20,
      perDay: 150,
      warmupDay: null,
      pauseSeconds: 30,
    });
    expect(callPace(settings, 0)).toEqual({
      ...common,
      perHour: 2,
      perDay: 10,
      warmupDay: 0,
      pauseSeconds: 90,
    });
    expect(callPace(settings, 6)).toMatchObject({ perHour: 8, perDay: 60, warmupDay: 6 });
    expect(callPace(settings, 0, 5)).toEqual({
      numbers: 5,
      poor: false,
      distinctPerHour: 75,
      distinctPerDay: 500,
      perHour: 10,
      perDay: 50,
      warmupDay: 0,
      pauseSeconds: 90,
    });
    expect(callPace({ ...settings, warmupEnabled: false }, 0)).toMatchObject({
      perHour: 20,
      perDay: 150,
      warmupDay: null,
      pauseSeconds: 30,
    });
    const off = {
      warmupEnabled: false,
      perHour: 0,
      perDay: 0,
      pauseSeconds: 0,
      warmupPauseSeconds: 0,
      distinctPerHour: 0,
      distinctPerDay: 0,
      sleepHours: 0,
      poorAnswerPercent: 0,
    };
    expect(callPace(off, null)).toEqual({
      numbers: 1,
      poor: false,
      perHour: null,
      perDay: null,
      warmupDay: null,
      pauseSeconds: null,
      distinctPerHour: null,
      distinctPerDay: null,
    });
    // Без рекомендованного «в сутки» прогрев растёт к запасному потолку, час — по доле; пауза прогрева — своя.
    expect(callPace({ ...off, warmupEnabled: true, warmupPauseSeconds: 90 }, 0)).toMatchObject({
      perHour: 2,
      perDay: 10,
      warmupDay: 0,
      pauseSeconds: 90,
    });
    // Пауза прогрева не короче обычной.
    expect(callPace({ ...settings, warmupPauseSeconds: 10 }, 0).pauseSeconds).toBe(30);
  });
});

describe('пауза номера после вызова (ADR-0106)', () => {
  const at = new Date('2026-10-30T12:00:00Z');
  const ended = (id: string, secondsAgo: number) => ({
    id,
    endedAt: new Date(at.getTime() - secondsAgo * 1000),
  });

  it('разброс — до половины паузы и один и тот же для одного ключа', () => {
    const keys = Array.from({ length: 200 }, (_, index) => `call-${String(index)}`);
    const shares = keys.map(paceJitter);
    expect(Math.min(...shares)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...shares)).toBeLessThan(1);
    // Не одна точка: промежутки должны различаться.
    expect(new Set(shares.map((share) => Math.round(share * 10))).size).toBeGreaterThan(5);
    expect(paceJitter('call-7')).toBe(paceJitter('call-7'));
    for (const key of keys) {
      const pause = jitteredPauseMs(30, key);
      expect(pause).toBeGreaterThanOrEqual(30_000);
      expect(pause).toBeLessThanOrEqual(45_000);
    }
  });

  it('SIM отдыхает после конца вызова, транк — когда отдыхают все его номера', () => {
    const sim = { pauseSeconds: 30, numbers: 1 };
    expect(callRestingUntil(sim, [ended('a', 5)], at)).not.toBeNull();
    // Пауза кончилась даже с самым большим разбросом.
    expect(callRestingUntil(sim, [ended('a', 46)], at)).toBeNull();
    expect(callRestingUntil({ ...sim, pauseSeconds: null }, [ended('a', 1)], at)).toBeNull();

    const trunk = { pauseSeconds: 30, numbers: 2 };
    expect(callRestingUntil(trunk, [ended('a', 5)], at)).toBeNull();
    const until = callRestingUntil(trunk, [ended('a', 5), ended('b', 10)], at);
    // Отдых до освобождения первого из мест — с учётом разброса каждого вызова.
    expect(until?.getTime()).toBe(
      Math.min(
        at.getTime() - 5_000 + jitteredPauseMs(30, 'a'),
        at.getTime() - 10_000 + jitteredPauseMs(30, 'b'),
      ),
    );
  });

  it('окно поиска прошлых вызовов покрывает самую длинную паузу с разбросом', () => {
    expect(
      callRestWindowMs({
        warmupEnabled: true,
        perHour: 0,
        perDay: 0,
        pauseSeconds: 30,
        warmupPauseSeconds: 90,
        distinctPerHour: 0,
        distinctPerDay: 0,
        sleepHours: 0,
        poorAnswerPercent: 0,
      }),
    ).toBe(135_000);
  });
});

describe('сон номера и «плохой» номер (ADR-0107)', () => {
  const keys = Array.from(
    { length: 400 },
    (_, index) => `0190aaaa-0000-7000-8000-${String(index).padStart(12, '0')}`,
  );
  const asleepShare = (iso: string): number =>
    keys.filter((key) => sleepUntil(key, 6, new Date(iso)) !== null).length / keys.length;

  it('ночью спит около половины номеров, днём — никто; пробуждение — не позже чем через 6 часов', () => {
    // 02:00 МСК = 23:00 UTC накануне; 15:00 МСК = 12:00 UTC.
    expect(asleepShare('2026-10-29T23:00:00Z')).toBeGreaterThan(0.35);
    expect(asleepShare('2026-10-29T23:00:00Z')).toBeLessThan(0.65);
    expect(asleepShare('2026-10-30T12:00:00Z')).toBe(0);
    const now = new Date('2026-10-29T23:00:30Z');
    for (const key of keys) {
      const until = sleepUntil(key, 6, now);
      if (until === null) continue;
      expect(until.getTime()).toBeGreaterThan(now.getTime());
      expect(until.getTime() - now.getTime()).toBeLessThanOrEqual(6 * 3_600_000);
      expect(sleepUntil(key, 6, now)).toEqual(until);
    }
    expect(sleepUntil(keys[0] ?? '', 0, now)).toBeNull();
  });

  it('«плохой» номер: от 20 попыток и ответов меньше доли — пределы вдвое', () => {
    expect(isPoorNumber(19, 0, 20)).toBe(false);
    expect(isPoorNumber(20, 3, 20)).toBe(true);
    expect(isPoorNumber(20, 4, 20)).toBe(false);
    expect(isPoorNumber(100, 0, 0)).toBe(false);
    const settings = {
      warmupEnabled: false,
      perHour: 15,
      perDay: 100,
      pauseSeconds: 30,
      warmupPauseSeconds: 90,
      distinctPerHour: 15,
      distinctPerDay: 100,
      sleepHours: 6,
      poorAnswerPercent: 20,
    };
    expect(callPace(settings, null, 1, true)).toMatchObject({
      poor: true,
      perHour: 8,
      perDay: 50,
      distinctPerHour: 8,
      distinctPerDay: 50,
      pauseSeconds: 30,
    });
  });
});
