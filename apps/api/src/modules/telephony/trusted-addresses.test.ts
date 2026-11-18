import { describe, expect, it } from 'vitest';
import { addressHost, TRUSTED_MARK, trustedAddressesText } from './trusted-addresses.js';

describe('доверенные адреса узла (ADR-0125)', () => {
  it('из отметки регистрации берётся только адрес', () => {
    expect(addressHost('94.198.51.21:5060/udp')).toBe('94.198.51.21');
    expect(addressHost('31.216.170.27:47123/tcp')).toBe('31.216.170.27');
    expect(addressHost('203.0.113.5')).toBe('203.0.113.5');
    expect(addressHost('[2001:db8::1]:5060/udp')).toBe('2001:db8::1');
    expect(addressHost('2001:db8::1:5060/udp')).toBe('2001:db8::1');
  });

  it('не адрес — не доверенный: в ignoreip уходит только проверенное', () => {
    expect(addressHost('')).toBeUndefined();
    expect(addressHost('sip.example.ru:5060/udp')).toBeUndefined();
    expect(addressHost('1.2.3.4; rm -rf /')).toBeUndefined();
  });

  it('текст: метка первой строкой, адреса без повторов и по порядку', () => {
    expect(
      trustedAddressesText([
        '94.198.51.21:5060/udp',
        '31.216.170.27:5060/udp',
        '94.198.51.21:6000/tcp',
      ]),
    ).toBe(`${TRUSTED_MARK}\n31.216.170.27\n94.198.51.21\n`);
    // Пустой список — тоже ответ: узел должен стереть прежние доверенные, если их больше нет.
    expect(trustedAddressesText([])).toBe(`${TRUSTED_MARK}\n`);
  });
});
