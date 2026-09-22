import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  PLATFORM_SETTING_PURPOSE,
  TOTP_SECRET_PURPOSE,
} from './secret-box.js';

const P = TOTP_SECRET_PURPOSE;

const KEY = 'x'.repeat(32);

describe('шифрование секретов', () => {
  it('расшифровывает то же, что зашифровало', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(decryptSecret(encryptSecret(secret, KEY, P), KEY, P)).toBe(secret);
  });

  it('два шифрования одного секрета дают разные строки', () => {
    // Одинаковый шифротекст выдавал бы, что у двух людей один и тот же секрет.
    expect(encryptSecret('одно и то же', KEY, P)).not.toBe(encryptSecret('одно и то же', KEY, P));
  });

  it('чужой ключ не расшифровывает', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP', KEY, P);
    expect(() => decryptSecret(stored, 'y'.repeat(32), P)).toThrow();
  });

  it('подменённый шифротекст не проходит проверку целостности', () => {
    // Ради этого и GCM: подмена обнаруживается, а не расшифровывается в мусор.
    const stored = encryptSecret('JBSWY3DPEHPK3PXP', KEY, P);
    const parts = stored.split(':');
    const broken = [parts[0], parts[1], Buffer.from('подмена').toString('base64url')].join(':');
    expect(() => decryptSecret(broken, KEY, P)).toThrow();
  });

  it('повреждённая строка отвергается внятно, а не падает разбором', () => {
    expect(() => decryptSecret('мусор', KEY, P)).toThrow('повреждён');
  });

  it('терпит непечатаемое и длинное', () => {
    const secret = `${'A'.repeat(200)}\u0000ё`;
    expect(decryptSecret(encryptSecret(secret, KEY, P), KEY, P)).toBe(secret);
  });
});

describe('назначение ключа', () => {
  it('секрет одного назначения не расшифровывается ключом другого', () => {
    // Ключ выводится из общего SECRET_KEY с назначением: утечка шифротекста настроек
    // не должна помогать разбирать секреты второго фактора.
    const stored = encryptSecret('значение', KEY, TOTP_SECRET_PURPOSE);
    expect(() => decryptSecret(stored, KEY, PLATFORM_SETTING_PURPOSE)).toThrow();
  });
});
