/**
 * Адрес SIP-провайдера партнёра — только внешний (ADR-0100, п. 2). DNS подменён: проверяется правило, а не сеть.
 */

import { describe, expect, it } from 'vitest';
import { hostOf, sipHostProblem, type Lookup } from './sip-host.js';

const dns =
  (table: Record<string, string[]>): Lookup =>
  (host) => {
    const found = table[host];
    return found === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(found);
  };

const lookup = dns({
  'sip.provider.ru': ['203.0.113.10'],
  'mixed.example': ['203.0.113.11', '10.0.0.5'],
  'v6.example': ['2001:db8::1', 'fe80::1'],
  'sip.zvonix.test': ['198.51.100.7'],
  'alias.example': ['198.51.100.7'],
});

describe('адрес SIP-провайдера', () => {
  it('внешний адрес по имени и с портом принимается', async () => {
    expect(await sipHostProblem('sip.provider.ru', [], lookup)).toBeUndefined();
    expect(await sipHostProblem('sip.provider.ru:5070', [], lookup)).toBeUndefined();
    expect(await sipHostProblem('203.0.113.10:5060', [], lookup)).toBeUndefined();
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.10:5060',
    '172.20.0.1',
    '100.64.1.1',
    '169.254.1.1',
    '0.0.0.0',
  ])('внутренний IP %s отклоняется', async (host) => {
    expect(await sipHostProblem(host, [], lookup)).toMatch(/внутренний/u);
  });

  it('имя, у которого хоть один адрес внутренний, отклоняется — узел может выбрать именно его', async () => {
    expect(await sipHostProblem('mixed.example', [], lookup)).toMatch(/внутренний/u);
    expect(await sipHostProblem('v6.example', [], lookup)).toMatch(/внутренний/u);
  });

  it('IPv4 внутри IPv6 проверяется как IPv4', async () => {
    const mapped = dns({ 'm.example': ['::ffff:10.0.0.1'], 'p.example': ['::ffff:203.0.113.10'] });
    expect(await sipHostProblem('m.example', [], mapped)).toMatch(/внутренний/u);
    expect(await sipHostProblem('p.example', [], mapped)).toBeUndefined();
  });

  it('неразрешимое имя — «адрес не найден»', async () => {
    expect(await sipHostProblem('nope.example', [], lookup)).toMatch(/не найден/u);
  });

  it('адрес узла площадки — петля, отклоняется и по имени, и по совпадающему IP', async () => {
    expect(await sipHostProblem('sip.zvonix.test', ['sip.zvonix.test:5060'], lookup)).toMatch(
      /самой площадки/u,
    );
    expect(await sipHostProblem('alias.example', ['sip.zvonix.test:5060'], lookup)).toMatch(
      /самой площадки/u,
    );
    expect(
      await sipHostProblem('sip.provider.ru', ['sip.zvonix.test:5060'], lookup),
    ).toBeUndefined();
  });

  it('неразрешимый адрес узла не мешает партнёру', async () => {
    expect(await sipHostProblem('sip.provider.ru', ['broken.node:5060'], lookup)).toBeUndefined();
  });

  it('порт отрезается от имени', () => {
    expect(hostOf('sip.provider.ru:5070')).toBe('sip.provider.ru');
    expect(hostOf('sip.provider.ru')).toBe('sip.provider.ru');
  });
});
