import { describe, expect, it } from 'vitest';
import { detectSipAddress } from './sip-address.js';

const SITE = 'https://cp.zvonix.com';

describe('адрес SIP узла по адресу обращения (ADR-0113)', () => {
  it('публичный адрес — он и есть адрес для GOIP', () => {
    expect(detectSipAddress('217.197.114.163', SITE)).toBe('217.197.114.163');
    expect(detectSipAddress('::ffff:217.197.114.163', SITE)).toBe('217.197.114.163');
    expect(detectSipAddress('2a01:4f8::1', SITE)).toBe('2a01:4f8::1');
  });

  it('узел на машине площадки — домен сайта', () => {
    expect(detectSipAddress('127.0.0.1', SITE)).toBe('cp.zvonix.com');
    expect(detectSipAddress('::1', SITE)).toBe('cp.zvonix.com');
  });

  it('частный адрес снаружи недоступен — не угадывается', () => {
    for (const ip of [
      '10.1.2.3',
      '172.16.0.5',
      '172.31.255.1',
      '192.168.80.94',
      '100.64.0.1',
      '169.254.1.1',
      'fd00::1',
      'fe80::1',
    ]) {
      expect(detectSipAddress(ip, SITE)).toBeUndefined();
    }
    // Соседи частных диапазонов — публичные.
    expect(detectSipAddress('172.32.0.1', SITE)).toBe('172.32.0.1');
    expect(detectSipAddress('100.128.0.1', SITE)).toBe('100.128.0.1');
  });

  it('адреса нет — нечего определять', () => {
    expect(detectSipAddress(undefined, SITE)).toBeUndefined();
    expect(detectSipAddress('', SITE)).toBeUndefined();
  });
});
