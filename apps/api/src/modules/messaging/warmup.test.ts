import { describe, expect, it } from 'vitest';
import { jitteredPauseMs, sleepUntil, type Id } from '@zvonix/shared';
import type { AccountLoad } from './messages.repository.js';
import { accountReadyAt, effectiveLimits, isIdle, restOf, withRecommended } from './warmup.js';

const NOW = new Date('2026-10-14T10:00:00Z');
const load = (overrides: Partial<AccountLoad>): AccountLoad => ({
  minute: 0,
  hour: 0,
  day: 0,
  backlog: 0,
  ...overrides,
});
const account = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1b2c3d4-0000-4000-8000-000000000001' as Id<'messengerAccount'>,
  warmupEnabled: false,
  warmupStartedAt: null,
  limitPerMinute: null,
  limitPerHour: null,
  limitPerDay: null,
  lastUsedAt: null,
  pausedUntil: null,
  ...overrides,
});
const options = { paceSeconds: 0, withBacklog: false };

describe('лимит сообщений в час (тариф MAX)', () => {
  it('без прогрева лимит в час — ровно то, что задал тариф', () => {
    expect(effectiveLimits(account({ limitPerHour: 40 }), NOW).hourly).toBe(40);
    expect(effectiveLimits(account(), NOW).hourly).toBeNull();
  });

  it('при прогреве берётся меньшее из заданного и равномерной доли суток', () => {
    const warming = {
      warmupEnabled: true,
      warmupStartedAt: new Date('2026-10-14T00:00:00Z'),
      limitPerDay: 500,
    };
    // Сутки 0 прогрева — 0 в сутки; часовая доля всё равно не меньше одного (не отправит — держит суточный ноль).
    expect(effectiveLimits(account({ ...warming, limitPerHour: 40 }), NOW).hourly).toBe(1);
    // Заданный лимит ниже доли — действует заданный.
    const later = new Date('2026-12-14T10:00:00Z');
    // Аккаунт работает — молчания нет, прогрев идёт обычным ходом.
    const used = { lastUsedAt: new Date('2026-12-14T09:00:00Z') };
    expect(effectiveLimits(account({ ...warming, ...used, limitPerHour: 5 }), later).hourly).toBe(
      5,
    );
  });

  it('исчерпанный час откладывает отправку, минута и сутки при этом не мешают', () => {
    const acc = account({ limitPerMinute: 10, limitPerHour: 20, limitPerDay: 500 });
    expect(accountReadyAt(acc, load({ hour: 19 }), NOW, options)).toBeUndefined();
    const wait = accountReadyAt(acc, load({ hour: 20 }), NOW, options);
    expect(wait).toBeDefined();
    expect((wait?.getTime() ?? 0) - NOW.getTime()).toBe(120_000);
  });

  it('запас партнёра сокращает и часовой лимит, но один раз в окне — всегда', () => {
    const acc = account({ limitPerHour: 10 });
    const reserve = { ...options, reservePercent: 20 };
    expect(accountReadyAt(acc, load({ hour: 7 }), NOW, reserve)).toBeUndefined();
    expect(accountReadyAt(acc, load({ hour: 8 }), NOW, reserve)).toBeDefined();
  });
});

describe('прогрев и молчание аккаунта (ADR-0078, ревизия 2026-10-18)', () => {
  const started = new Date('2026-08-01T00:00:00Z');
  const warming = { warmupEnabled: true, warmupStartedAt: started, limitPerDay: 500 };

  it('работающий аккаунт прогревается обычным ходом: через 40 суток — потолок', () => {
    const at = new Date('2026-09-10T10:00:00Z');
    const used = new Date('2026-09-10T09:00:00Z');
    const limits = effectiveLimits(account({ ...warming, lastUsedAt: used }), at);
    expect(limits.daily).toBe(500);
    expect(limits.warmupDay).toBeNull();
  });

  it('молчал дольше 14 суток — прогрев с суток 1 (3 в сутки), а не с нуля: иначе не отправил бы ничего и не перезапустился', () => {
    const at = new Date('2026-09-10T10:00:00Z');
    const used = new Date('2026-08-20T10:00:00Z'); // 21 сутки назад
    const limits = effectiveLimits(account({ ...warming, lastUsedAt: used }), at);
    expect(limits.daily).toBe(3);
    expect(limits.warmupDay).toBe(1);
  });

  it('сутки 0 прогрева — аккаунт не берёт сообщений; в таблице — «прогрев: первые сутки» до конца суток', () => {
    const at = new Date('2026-09-10T10:00:00Z');
    const started = new Date('2026-09-10T02:00:00Z');
    const fresh = account({ ...warming, warmupStartedAt: started, lastUsedAt: null });
    expect(effectiveLimits(fresh, at).daily).toBe(0);
    expect(
      accountReadyAt(fresh, load({}), at, { paceSeconds: 0, withBacklog: true }),
    ).toBeDefined();
    expect(restOf(fresh, load({}), at, { reservePercent: 0, quietEnd: undefined })).toEqual({
      reason: 'warmup',
      until: new Date('2026-09-11T02:00:00Z'),
    });
  });

  it('ровно 14 суток молчания — ещё не сброс, 15 — уже сброс', () => {
    const at = new Date('2026-09-10T10:00:00Z');
    const within = new Date(at.getTime() - 14 * 86_400_000);
    const beyond = new Date(at.getTime() - 15 * 86_400_000);
    expect(isIdle(account({ ...warming, lastUsedAt: within }), at)).toBe(false);
    expect(isIdle(account({ ...warming, lastUsedAt: beyond }), at)).toBe(true);
  });

  it('ни разу не отправлял: молчание считается от начала прогрева', () => {
    expect(isIdle(account(warming), new Date('2026-08-10T00:00:00Z'))).toBe(false);
    expect(isIdle(account(warming), new Date('2026-08-20T00:00:00Z'))).toBe(true);
  });

  it('старый аккаунт без начала прогрева считается прогретым и не «засыпает»', () => {
    const old = account({ warmupEnabled: true, warmupStartedAt: null, limitPerDay: 300 });
    expect(isIdle(old, NOW)).toBe(false);
    expect(effectiveLimits(old, NOW).daily).toBe(300);
  });

  it('прогрев выключен — молчание ничего не меняет', () => {
    const off = account({ warmupEnabled: false, limitPerDay: 200, lastUsedAt: null });
    expect(effectiveLimits(off, NOW).daily).toBe(200);
  });
});

describe('рекомендованная работа (ADR-0088)', () => {
  const profile = { paceSeconds: 20, perMinute: 2, perHour: 15, perDay: 80, sleepHours: 0 };
  const own = (overrides: Record<string, unknown> = {}) => ({
    recommended: true,
    limitPerMinute: null as number | null,
    limitPerHour: null as number | null,
    limitPerDay: null as number | null,
    ...overrides,
  });

  it('лимиты тарифа не действуют: работает профиль площадки', () => {
    expect(withRecommended(own(), profile)).toMatchObject({
      limitPerMinute: 2,
      limitPerHour: 15,
      limitPerDay: 80,
      recommendedPaceSeconds: 20,
    });
    expect(
      withRecommended(own({ limitPerMinute: 1, limitPerHour: 100, limitPerDay: 500 }), profile),
    ).toMatchObject({ limitPerMinute: 2, limitPerHour: 15, limitPerDay: 80 });
  });

  it('ноль у одного предела профиля — он без ограничения, лимит тарифа не действует; профиль из одних нулей и снятая галочка — аккаунт как есть', () => {
    expect(
      withRecommended(own({ limitPerMinute: 1, limitPerDay: 9 }), {
        paceSeconds: 20,
        perMinute: 0,
        perHour: 0,
        perDay: 0,
        sleepHours: 0,
      }),
    ).toMatchObject({ limitPerMinute: null, limitPerHour: null, limitPerDay: null });
    const zeros = { paceSeconds: 0, perMinute: 0, perHour: 0, perDay: 0, sleepHours: 0 };
    const tariffOnly = own({ limitPerMinute: 1 });
    expect(withRecommended(tariffOnly, zeros)).toBe(tariffOnly);
    const off = own({ recommended: false, limitPerMinute: 50 });
    expect(withRecommended(off, profile)).toBe(off);
  });

  it('пауза профиля удлиняет паузу между сообщениями, но не сокращает общую', () => {
    const last = new Date(NOW.getTime() - 10_000);
    const base = account({ lastUsedAt: last });
    const limited = withRecommended({ ...base, recommended: true }, profile);
    const key = `${limited.id}:${last.toISOString()}`;
    expect(accountReadyAt(limited, load({}), NOW, options)?.getTime()).toBe(
      last.getTime() + jitteredPauseMs(20, key),
    );
    expect(
      accountReadyAt(limited, load({}), NOW, { paceSeconds: 60, withBacklog: false })?.getTime(),
    ).toBe(last.getTime() + jitteredPauseMs(60, key));
  });

  it('пауза с разбросом до половины, одна и та же при повторном расчёте (ADR-0106)', () => {
    const last = new Date(NOW.getTime() - 1000);
    const sender = account({ lastUsedAt: last });
    const options60 = { paceSeconds: 60, withBacklog: false };
    const ready = accountReadyAt(sender, load({}), NOW, options60)?.getTime() ?? 0;
    expect(ready - last.getTime()).toBeGreaterThanOrEqual(60_000);
    expect(ready - last.getTime()).toBeLessThanOrEqual(90_000);
    expect(accountReadyAt(sender, load({}), NOW, options60)?.getTime()).toBe(ready);
  });
});

describe('почему аккаунт на паузе — для таблиц партнёра и сотрудников', () => {
  const none = { reservePercent: 0, quietEnd: undefined };

  it('работает — паузы нет; очередь и пауза между сообщениями паузой не считаются', () => {
    expect(
      restOf(account({ limitPerHour: 10 }), load({ hour: 9, backlog: 5 }), NOW, none),
    ).toBeUndefined();
    expect(
      restOf(account({ lastUsedAt: new Date(NOW.getTime() - 1000) }), load({}), NOW, none),
    ).toBeUndefined();
  });

  it('пауза здоровья и тихие часы — со временем снятия; здоровье важнее', () => {
    const until = new Date(NOW.getTime() + 3_600_000);
    const quietEnd = new Date(NOW.getTime() + 600_000);
    expect(
      restOf(account({ pausedUntil: until }), load({}), NOW, { reservePercent: 0, quietEnd }),
    ).toEqual({
      reason: 'health',
      until,
    });
    expect(restOf(account(), load({}), NOW, { reservePercent: 0, quietEnd })).toEqual({
      reason: 'quiet',
      until: quietEnd,
    });
  });

  it('исчерпан лимит — причина и окно; запас партнёра уменьшает доступное', () => {
    expect(restOf(account({ limitPerMinute: 3 }), load({ minute: 3 }), NOW, none)).toEqual({
      reason: 'minute',
      window: { windowMs: 60_000, allowed: 3 },
    });
    expect(
      restOf(account({ limitPerHour: 10 }), load({ hour: 8 }), NOW, {
        reservePercent: 20,
        quietEnd: undefined,
      }),
    ).toEqual({
      reason: 'hour',
      window: { windowMs: 3_600_000, allowed: 8 },
    });
    expect(restOf(account({ limitPerDay: 50 }), load({ day: 50 }), NOW, none)).toMatchObject({
      reason: 'day',
    });
  });
});

describe('сон аккаунта (ADR-0107)', () => {
  it('спящий аккаунт ждёт до пробуждения; сон у всех аккаунтов, даже без галочки', () => {
    const profile = { paceSeconds: 0, perMinute: 0, perHour: 0, perDay: 0, sleepHours: 12 };
    const base = { ...account(), recommended: false };
    const sleepy = withRecommended(base, profile);
    // Полсуток сна в полосе 20:00–08:00 МСК: в 02:00 МСК (23:00 UTC) спит любой аккаунт.
    const night = new Date('2026-10-14T23:00:00Z');
    const until = sleepUntil(base.id, 12, night);
    expect(until).not.toBeNull();
    expect(accountReadyAt(sleepy, load({}), night, options)).toEqual(until);
    expect(restOf(sleepy, load({}), night, { reservePercent: 0, quietEnd: undefined })).toEqual({
      reason: 'sleep',
      until,
    });
    const awake = withRecommended(base, { ...profile, sleepHours: 0 });
    expect(accountReadyAt(awake, load({}), night, options)).toBeUndefined();
  });
});
