import { describe, expect, it } from 'vitest';
import {
  CHANNEL_REGISTRATION_FRESH_MS,
  isChannelConnected,
  parseRegistrations,
} from './channel-registrations.service.js';
import type { ChannelRow } from './telephony.repository.js';

describe('разбор `show registrations as json`', () => {
  it('пустой список у FreeSWITCH — без `rows`', () => {
    expect(parseRegistrations('{"row_count":0}\n')).toEqual([]);
  });

  it('строка регистрации — имя, домен, срок и адрес', () => {
    const body = JSON.stringify({
      row_count: 1,
      rows: [
        {
          reg_user: 'ch-abcdefabcdef',
          realm: 'sip.zvonix.test',
          token: 't',
          url: 'sofia/zvonix/sip:ch-abcdefabcdef@203.0.113.5:5060',
          expires: '1800000000',
          network_ip: '203.0.113.5',
          network_port: '5060',
          network_proto: 'udp',
          hostname: 'node',
          metadata: '',
        },
      ],
    });
    expect(parseRegistrations(body)).toEqual([
      {
        username: 'ch-abcdefabcdef',
        realm: 'sip.zvonix.test',
        expiresAt: new Date(1_800_000_000_000),
        address: '203.0.113.5:5060/udp',
      },
    ]);
  });

  it('негодная строка отбрасывается, остальные остаются', () => {
    const body = JSON.stringify({
      row_count: 3,
      rows: [
        { reg_user: '', realm: 'r', expires: '1800000000' },
        { reg_user: 'ch-x', realm: 'r', expires: 'никогда' },
        { reg_user: 'ch-y', realm: 'r', expires: '1800000000', network_ip: '198.51.100.1' },
        'мусор',
      ],
    });
    expect(parseRegistrations(body).map((entry) => [entry.username, entry.address])).toEqual([
      ['ch-y', '198.51.100.1'],
    ]);
  });

  it('ответ не JSON — ошибка узла, а не «никого нет»', () => {
    expect(() => parseRegistrations('-ERR no reply')).toThrow(/не JSON/u);
    expect(() => parseRegistrations('{"rows":{}}')).toThrow(/не список/u);
  });
});

describe('подключена ли линия', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const line = (seenAgoMs: number | null, expiresInMs: number | null) =>
    ({
      registrationSeenAt: seenAgoMs === null ? null : new Date(now.getTime() - seenAgoMs),
      registrationExpiresAt: expiresInMs === null ? null : new Date(now.getTime() + expiresInMs),
    }) as ChannelRow;

  it('свежая и не истекшая — подключена', () => {
    expect(isChannelConnected(line(30_000, 600_000), now)).toBe(true);
  });

  it('истекшая регистрация — нет', () => {
    expect(isChannelConnected(line(30_000, -1), now)).toBe(false);
  });

  it('опрос давно не видел — нет: узел молчит или программа ушла', () => {
    expect(isChannelConnected(line(CHANNEL_REGISTRATION_FRESH_MS + 1, 600_000), now)).toBe(false);
  });

  it('никогда не видели — нет', () => {
    expect(isChannelConnected(line(null, null), now)).toBe(false);
  });
});
