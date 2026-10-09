import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISTRIBUTION,
  minuteOfDay,
  quietEndsAt,
  type DistributionSettings,
} from '@zvonix/shared';
import { chooseByMode, type Candidate } from './distribution.js';
import type { MessengerAccountRow } from './messaging.repository.js';

const NOW = new Date('2026-10-09T12:00:00Z'); // 15:00 по Москве

function account(name: string, extra: Partial<MessengerAccountRow> = {}): MessengerAccountRow {
  return {
    id: name,
    warmupEnabled: false,
    warmupStartedAt: null,
    limitPerDay: null,
    limitPerMinute: null,
    lastUsedAt: null,
    pausedUntil: null,
    distributionWeight: 1,
    distributionPriority: 1,
    ...extra,
  } as unknown as MessengerAccountRow;
}

const candidate = (
  name: string,
  load: Partial<Candidate['load']> = {},
  extra: Partial<MessengerAccountRow> = {},
): Candidate => ({
  account: account(name, extra),
  load: { minute: 0, hour: 0, day: 0, backlog: 0, ...load },
});

const settings = (patch: Partial<DistributionSettings>): DistributionSettings => ({
  ...DEFAULT_DISTRIBUTION,
  ...patch,
});

const pick = (list: Candidate[], patch: Partial<DistributionSettings>) =>
  chooseByMode(list, settings(patch), NOW, 0)?.account.id;

describe('режимы распределения', () => {
  it('«поровну»: короткая очередь первой, при равенстве — ранний в списке', () => {
    expect(
      pick([candidate('a', { backlog: 3 }), candidate('b', { backlog: 1 })], { mode: 'equal' }),
    ).toBe('b');
    expect(pick([candidate('a'), candidate('b')], { mode: 'equal' })).toBe('a');
  });

  it('«по остатку»: больше остатка суточного лимита — первым', () => {
    const list = [
      candidate('a', { day: 80 }, { limitPerDay: 100 }),
      candidate('b', { day: 10 }, { limitPerDay: 100 }),
      candidate('c', { day: 40 }, { limitPerDay: 300 }),
    ];
    expect(pick(list, { mode: 'remaining' })).toBe('c');
  });

  it('«по весам»: трафик делится пропорционально — выигрывает тот, кто меньше получил на единицу веса', () => {
    const list = [
      candidate('a', { day: 30 }, { distributionWeight: 3 }),
      candidate('b', { day: 15 }, { distributionWeight: 1 }),
    ];
    expect(pick(list, { mode: 'weighted' })).toBe('a'); // 10 на вес против 15
    const evened = [
      candidate('a', { day: 45 }, { distributionWeight: 3 }),
      candidate('b', { day: 10 }, { distributionWeight: 1 }),
    ];
    expect(pick(evened, { mode: 'weighted' })).toBe('b'); // 15 против 10
  });

  it('«по порядку»: первый свободный в списке, упёршегося пропускает', () => {
    const list = [
      candidate('a', { day: 5 }, { limitPerDay: 5 }),
      candidate('b', { day: 1 }, { limitPerDay: 5 }),
      candidate('c'),
    ];
    expect(pick(list, { mode: 'sequential' })).toBe('b');
  });

  it('«по приоритету»: меньший номер первым, внутри одного — с короткой очередью', () => {
    const list = [
      candidate('a', {}, { distributionPriority: 2 }),
      candidate('b', { backlog: 4 }, { distributionPriority: 1 }),
      candidate('c', { backlog: 1 }, { distributionPriority: 1 }),
    ];
    expect(pick(list, { mode: 'priority' })).toBe('c');
  });

  it('никто не свободен — выбора нет', () => {
    expect(
      pick([candidate('a', { day: 5 }, { limitPerDay: 5 })], { mode: 'equal' }),
    ).toBeUndefined();
  });
});

describe('запас лимита', () => {
  it('с запасом 20 % из 10 доступно 8; один всегда остаётся', () => {
    const near = candidate('a', { day: 8 }, { limitPerDay: 10 });
    expect(pick([near], { reservePercent: 0 })).toBe('a');
    expect(pick([near], { reservePercent: 20 })).toBeUndefined();
    expect(pick([candidate('b', { day: 7 }, { limitPerDay: 10 })], { reservePercent: 20 })).toBe(
      'b',
    );
    expect(pick([candidate('c', {}, { limitPerDay: 1 })], { reservePercent: 50 })).toBe('c');
  });
});

describe('тихие часы', () => {
  it('минута суток считается в поясе партнёра, неверный пояс — UTC', () => {
    expect(minuteOfDay(NOW, 'Europe/Moscow')).toBe(15 * 60);
    expect(minuteOfDay(NOW, 'Asia/Vladivostok')).toBe(22 * 60);
    expect(minuteOfDay(NOW, 'Не/Пояс')).toBe(12 * 60);
  });

  it('окно внутри суток и через полночь; конец окна называется временем', () => {
    const day = settings({ quietFromMinute: 14 * 60, quietToMinute: 16 * 60 });
    expect(quietEndsAt(day, NOW)?.toISOString()).toBe('2026-10-09T13:00:00.000Z');
    expect(
      quietEndsAt(settings({ quietFromMinute: 16 * 60, quietToMinute: 18 * 60 }), NOW),
    ).toBeUndefined();

    const night = settings({ quietFromMinute: 22 * 60, quietToMinute: 8 * 60 });
    expect(quietEndsAt(night, NOW)).toBeUndefined();
    const midnight = new Date('2026-10-09T22:30:00Z'); // 01:30 по Москве, уже 10 октября
    expect(quietEndsAt(night, midnight)?.toISOString()).toBe('2026-10-10T05:00:00.000Z');
    expect(quietEndsAt(DEFAULT_DISTRIBUTION, NOW)).toBeUndefined();
  });

  it('в тихие часы аккаунт не выбирается', () => {
    expect(
      pick([candidate('a')], { quietFromMinute: 14 * 60, quietToMinute: 16 * 60 }),
    ).toBeUndefined();
  });
});
