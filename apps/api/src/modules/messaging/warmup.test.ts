import { describe, expect, it } from 'vitest';
import type { AccountLoad } from './messages.repository.js';
import { accountReadyAt, effectiveLimits, isIdle, withRecommended } from './warmup.js';

const NOW = new Date('2026-10-14T10:00:00Z');
const load = (overrides: Partial<AccountLoad>): AccountLoad => ({
  minute: 0,
  hour: 0,
  day: 0,
  backlog: 0,
  ...overrides,
});
const account = (overrides: Record<string, unknown> = {}) => ({
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
    // Первые сутки прогрева — 12 в сутки, равномерная доля — 1 в час.
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

  it('молчал дольше 14 суток — снова первые сутки: 12 в сутки', () => {
    const at = new Date('2026-09-10T10:00:00Z');
    const used = new Date('2026-08-20T10:00:00Z'); // 21 сутки назад
    const limits = effectiveLimits(account({ ...warming, lastUsedAt: used }), at);
    expect(limits.daily).toBe(12);
    expect(limits.warmupDay).toBe(0);
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
  const profile = { paceSeconds: 20, perMinute: 2, perHour: 15, perDay: 80 };
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
      }),
    ).toMatchObject({ limitPerMinute: null, limitPerHour: null, limitPerDay: null });
    const zeros = { paceSeconds: 0, perMinute: 0, perHour: 0, perDay: 0 };
    const tariffOnly = own({ limitPerMinute: 1 });
    expect(withRecommended(tariffOnly, zeros)).toBe(tariffOnly);
    const off = own({ recommended: false, limitPerMinute: 50 });
    expect(withRecommended(off, profile)).toBe(off);
  });

  it('пауза профиля удлиняет паузу между сообщениями, но не сокращает общую', () => {
    const last = new Date(NOW.getTime() - 10_000);
    const base = account({ lastUsedAt: last });
    const limited = withRecommended({ ...base, recommended: true }, profile);
    expect(accountReadyAt(limited, load({}), NOW, options)?.getTime()).toBe(
      last.getTime() + 20_000,
    );
    expect(
      accountReadyAt(limited, load({}), NOW, { paceSeconds: 60, withBacklog: false })?.getTime(),
    ).toBe(last.getTime() + 60_000);
  });
});
