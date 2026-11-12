import { describe, expect, it } from 'vitest';
import { checkSipAddress, hostOf, suggestedName, type ResolveName } from './sip-dns.js';

const SITE = 'https://cp.zvonix.com';
const NODE = '217.197.114.163';

/** DNS по таблице: имени нет в таблице — записи нет; 'fail' — DNS не ответил. */
const dns =
  (table: Record<string, readonly string[] | 'fail'>): ResolveName =>
  (name) => {
    const found = table[name];
    if (found === 'fail') return Promise.reject(new Error('timeout'));
    return Promise.resolve({ addresses: found, authoritative: true, stale: null });
  };

describe('проверка адреса SIP узла (ADR-0113, ревизия)', () => {
  it('имя ведёт на узел — всё верно; подсказка записи есть всегда', async () => {
    const check = await checkSipAddress({
      address: 'sip.zvonix.com',
      nodeAddress: NODE,
      publicBaseUrl: SITE,
      resolve: dns({ 'sip.zvonix.com': [NODE] }),
    });
    expect(check.verdict).toBe('ok');
    expect(check.record).toEqual({ name: 'sip.zvonix.com', type: 'A', value: NODE });
  });

  it('имени нет — «заведите запись»; ведёт не туда — называется куда', async () => {
    const missing = await checkSipAddress({
      address: 'sip.zvonix.com',
      nodeAddress: NODE,
      publicBaseUrl: SITE,
      resolve: dns({}),
    });
    expect(missing.verdict).toBe('missing');
    // Запись — для вписанного имени: его и нужно завести, а не придуманное.
    const typed = await checkSipAddress({
      address: 'voip.zvonix.com',
      nodeAddress: NODE,
      publicBaseUrl: SITE,
      resolve: dns({}),
    });
    expect(typed.record).toEqual({ name: 'voip.zvonix.com', type: 'A', value: NODE });

    const wrong = await checkSipAddress({
      address: 'sip.zvonix.com:5060',
      nodeAddress: NODE,
      publicBaseUrl: SITE,
      resolve: dns({ 'sip.zvonix.com': ['217.197.114.155'] }),
    });
    expect(wrong.verdict).toBe('mismatch');
    expect(wrong.resolved).toEqual(['217.197.114.155']);
  });

  it('главные серверы — верно, кэш хостинга ещё помнит старое: «верно» и срок кэша', async () => {
    // Ровно случай 2026-11-12: регистратор и весь мир — 217.197.114.163, DNS хостинга — 78.17.98.160.
    const check = await checkSipAddress({
      address: 'sip.zvonix.com',
      nodeAddress: NODE,
      publicBaseUrl: SITE,
      resolve: () =>
        Promise.resolve({
          addresses: [NODE],
          authoritative: true,
          stale: { addresses: ['78.17.98.160'], expiresInSeconds: 2547 },
        }),
    });
    expect(check.verdict).toBe('ok');
    expect(check.authoritative).toBe(true);
    expect(check.stale).toEqual({ addresses: ['78.17.98.160'], expiresInSeconds: 2547 });
  });

  it('указан IP: свой — работает, но лучше имя; чужой — ошибка', async () => {
    const own = await checkSipAddress({
      address: NODE,
      nodeAddress: NODE,
      publicBaseUrl: SITE,
      resolve: dns({}),
    });
    expect(own.verdict).toBe('ip');
    const other = await checkSipAddress({
      address: '5.6.7.8',
      nodeAddress: NODE,
      publicBaseUrl: SITE,
      resolve: dns({}),
    });
    expect(other.verdict).toBe('ip_mismatch');
  });

  it('узел на машине сайта: имя должно вести туда же, куда домен сайта', async () => {
    const check = await checkSipAddress({
      address: 'sip.zvonix.com',
      nodeAddress: '127.0.0.1',
      publicBaseUrl: SITE,
      resolve: dns({ 'cp.zvonix.com': ['217.197.114.155'], 'sip.zvonix.com': ['217.197.114.155'] }),
    });
    expect(check.verdict).toBe('ok');
    expect(check.expected).toEqual(['217.197.114.155']);
  });

  it('узел за NAT или не обращался — сравнить не с чем, подсказки нет', async () => {
    const check = await checkSipAddress({
      address: 'sip.zvonix.com',
      nodeAddress: '192.168.1.5',
      publicBaseUrl: SITE,
      resolve: dns({ 'sip.zvonix.com': [NODE] }),
    });
    expect(check.verdict).toBe('unverifiable');
    expect(check.record).toBeNull();
  });

  it('адреса нет — «не задан»; DNS молчит — «не удалось проверить», а не «записи нет»', async () => {
    expect(
      (
        await checkSipAddress({
          address: null,
          nodeAddress: NODE,
          publicBaseUrl: SITE,
          resolve: dns({}),
        })
      ).verdict,
    ).toBe('none');
    expect(
      (
        await checkSipAddress({
          address: 'sip.zvonix.com',
          nodeAddress: NODE,
          publicBaseUrl: SITE,
          resolve: dns({ 'sip.zvonix.com': 'fail' }),
        })
      ).verdict,
    ).toBe('error');
  });

  it('имя без порта и предложенное имя', () => {
    expect(hostOf('sip.zvonix.com:5070')).toBe('sip.zvonix.com');
    expect(hostOf('[2001:db8::1]:5060')).toBe('2001:db8::1');
    expect(hostOf('2001:db8::1')).toBe('2001:db8::1');
    expect(suggestedName('cp.zvonix.com')).toBe('sip.zvonix.com');
    expect(suggestedName('zvonix.com')).toBe('sip.zvonix.com');
    expect(suggestedName('127.0.0.1')).toBeNull();
  });
});
