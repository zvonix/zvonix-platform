import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './secret-box.js';

const KEY = 'x'.repeat(32);

describe('шифрование секретов', () => {
  it('расшифровывает то же, что зашифровало', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret);
  });

  it('два шифрования одного секрета дают разные строки', () => {
    // Одинаковый шифротекст выдавал бы, что у двух людей один и тот же секрет.
    expect(encryptSecret('одно и то же', KEY)).not.toBe(encryptSecret('одно и то же', KEY));
  });

  it('чужой ключ не расшифровывает', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP', KEY);
    expect(() => decryptSecret(stored, 'y'.repeat(32))).toThrow();
  });

  it('подменённый шифротекст не проходит проверку целостности', () => {
    // Ради этого и GCM: подмена обнаруживается, а не расшифровывается в мусор.
    const stored = encryptSecret('JBSWY3DPEHPK3PXP', KEY);
    const parts = stored.split(':');
    const broken = [parts[0], parts[1], Buffer.from('подмена').toString('base64url')].join(':');
    expect(() => decryptSecret(broken, KEY)).toThrow();
  });

  it('повреждённая строка отвергается внятно, а не падает разбором', () => {
    expect(() => decryptSecret('мусор', KEY)).toThrow('повреждён');
  });

  it('терпит непечатаемое и длинное', () => {
    const secret = `${'A'.repeat(200)}\u0000ё`;
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret);
  });
});
