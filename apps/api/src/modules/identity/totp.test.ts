/**
 * Проверка второго фактора контрольными векторами стандартов (ADR-0028).
 *
 * Своя реализация TOTP оправдана ровно этим: она совпадает со стандартом на его же
 * векторах, а не «наверное, верная». Векторы взяты из RFC 4648 (base32) и RFC 6238
 * (приложение B, таблица контрольных значений).
 */

import { describe, expect, it } from 'vitest';
import {
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  otpauthUri,
  stepAt,
  totpAt,
  TOTP_STEP_SECONDS,
  verifyTotp,
} from './totp.js';

/** Секрет из RFC 6238: строка `12345678901234567890` в base32. */
const RFC_SECRET = encodeBase32(Buffer.from('12345678901234567890', 'ascii'));

describe('base32 по RFC 4648', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('«%s» → %s', (input, expected) => {
    expect(encodeBase32(Buffer.from(input, 'ascii'))).toBe(expected);
  });

  it('разбор возвращает исходные байты', () => {
    for (const value of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
      expect(decodeBase32(encodeBase32(Buffer.from(value, 'ascii'))).toString('ascii')).toBe(value);
    }
  });

  it('терпит пробелы, выравнивание и нижний регистр', () => {
    // Человек переносит секрет глазами и вводит руками.
    expect(decodeBase32('mzxw 6ytb oi==').toString('ascii')).toBe('foobar');
  });

  it('отвергает недопустимый символ, а не молча его пропускает', () => {
    expect(() => decodeBase32('MZXW6YTB1')).toThrow();
  });
});

describe('коды по RFC 6238', () => {
  // Приложение B стандарта: время в секундах и ожидаемый восьмизначный код для SHA1.
  // Здесь проверяются шесть младших цифр — столько мы и показываем.
  it.each([
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
    [20_000_000_000, '353130'],
  ])('на %s секунде код %s', (seconds, expected) => {
    const step = Math.floor(seconds / TOTP_STEP_SECONDS);
    expect(totpAt(RFC_SECRET, step)).toBe(expected);
  });
});

describe('проверка кода', () => {
  const at = new Date('2026-09-03T12:00:00Z');

  it('принимает код текущего шага', () => {
    const code = totpAt(RFC_SECRET, stepAt(at));
    expect(verifyTotp(RFC_SECRET, code, at)).toBe(stepAt(at));
  });

  it('прощает уход часов на один шаг в обе стороны', () => {
    // Иначе второй фактор, отвергающий верный код из-за пятнадцати секунд расхождения,
    // люди просто выключают.
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, stepAt(at) - 1), at)).toBe(stepAt(at) - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, stepAt(at) + 1), at)).toBe(stepAt(at) + 1);
  });

  it('не прощает двух шагов', () => {
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, stepAt(at) + 2), at)).toBeUndefined();
  });

  it('не принимает уже использованный шаг', () => {
    // RFC 6238, раздел 5.2: подсмотренный код иначе работает все свои тридцать секунд.
    const step = stepAt(at);
    const code = totpAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, at, { minStep: step })).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, code, at, { minStep: step - 1 })).toBe(step);
  });

  it('отвергает мусор, не считая его кодом', () => {
    expect(verifyTotp(RFC_SECRET, '12345', at)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, '1234567', at)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, 'абвгде', at)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, '', at)).toBeUndefined();
  });

  it('терпит пробел, которым код разбивают пополам', () => {
    const code = totpAt(RFC_SECRET, stepAt(at));
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(RFC_SECRET, spaced, at)).toBe(stepAt(at));
  });
});

describe('секрет и ссылка', () => {
  it('новый секрет разбирается и даёт рабочий код', () => {
    const secret = generateTotpSecret();
    const at = new Date();
    expect(verifyTotp(secret, totpAt(secret, stepAt(at)), at)).toBe(stepAt(at));
  });

  it('два секрета подряд не совпадают', () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  it('ссылка несёт всё, что нужно аутентификатору', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'admin@example.com', 'Zvonix');
    expect(uri).toContain('otpauth://totp/Zvonix:admin%40example.com');
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('period=30');
    expect(uri).toContain('digits=6');
  });
});
