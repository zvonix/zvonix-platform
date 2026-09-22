import { describe, expect, it } from 'vitest';
import { acceptsFirstRunCode, firstRunCode } from './first-run.js';

const KEY = 'ключ-приложения-для-проверки-кода-первого-запуска';
const NOON = new Date('2026-09-22T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('код первого запуска (ADR-0050)', () => {
  it('двенадцать знаков base32 группами по четыре', () => {
    expect(firstRunCode(KEY, NOON).code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/u);
  });

  it('один на сутки UTC: утро и вечер одних суток дают один код, следующие — другой', () => {
    const morning = firstRunCode(KEY, new Date('2026-09-22T00:00:01.000Z')).code;
    const evening = firstRunCode(KEY, new Date('2026-09-22T23:59:59.000Z')).code;
    const tomorrow = firstRunCode(KEY, new Date('2026-09-23T00:00:01.000Z')).code;
    expect(evening).toBe(morning);
    expect(tomorrow).not.toBe(morning);
  });

  it('действует до конца следующих суток — и ни мгновением дольше', () => {
    const { code, validUntil } = firstRunCode(KEY, NOON);
    expect(validUntil.toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(acceptsFirstRunCode(KEY, code, new Date(validUntil.getTime() - 1))).toBe(true);
    expect(acceptsFirstRunCode(KEY, code, validUntil)).toBe(false);
  });

  it('принимается в свои и следующие сутки — код за минуту до полуночи не сгорает', () => {
    const { code } = firstRunCode(KEY, NOON);
    expect(acceptsFirstRunCode(KEY, code, NOON)).toBe(true);
    expect(acceptsFirstRunCode(KEY, code, new Date(NOON.getTime() + DAY_MS))).toBe(true);
    expect(acceptsFirstRunCode(KEY, code, new Date(NOON.getTime() + 2 * DAY_MS))).toBe(false);
    // И не раньше своих суток: код завтрашнего дня сегодня не подходит.
    const tomorrow = firstRunCode(KEY, new Date(NOON.getTime() + DAY_MS)).code;
    expect(acceptsFirstRunCode(KEY, tomorrow, NOON)).toBe(false);
  });

  it('регистр, пробелы и дефисы не важны — человек переписывает код руками', () => {
    const { code } = firstRunCode(KEY, NOON);
    const bare = code.replaceAll('-', '');
    expect(acceptsFirstRunCode(KEY, bare.toLowerCase(), NOON)).toBe(true);
    expect(acceptsFirstRunCode(KEY, ` ${bare.slice(0, 6)} ${bare.slice(6)} `, NOON)).toBe(true);
  });

  it('чужой ключ, чужой код и обрезок не подходят', () => {
    const { code } = firstRunCode(KEY, NOON);
    expect(acceptsFirstRunCode(`${KEY}-другой`, code, NOON)).toBe(false);
    expect(acceptsFirstRunCode(KEY, 'AAAA-AAAA-AAAA', NOON)).toBe(false);
    expect(acceptsFirstRunCode(KEY, code.slice(0, 9), NOON)).toBe(false);
    expect(acceptsFirstRunCode(KEY, '', NOON)).toBe(false);
  });

  it('ключ выводится с назначением: код не совпадает с простым HMAC по самому SECRET_KEY', async () => {
    // Одинаковый код при разных назначениях значил бы, что ключ второго фактора и ключ
    // кода первого запуска — один и тот же материал.
    const { createHmac } = await import('node:crypto');
    const { encodeBase32 } = await import('./totp.js');
    const day = Math.floor(NOON.getTime() / DAY_MS);
    const naive = encodeBase32(
      createHmac('sha256', KEY)
        .update(`day:${String(day)}`)
        .digest(),
    );
    expect(firstRunCode(KEY, NOON).code.replaceAll('-', '')).not.toBe(naive.slice(0, 12));
  });
});
