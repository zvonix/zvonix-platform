import { describe, expect, it } from 'vitest';
import {
  deviceConnection,
  KNOCK_RECENT_MS,
  REGISTRATION_FRESH_MS,
  isRegistered,
  parseRegistrations,
} from './registrations.service.js';
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
    expect(isRegistered(line(30_000, 600_000), now)).toBe(true);
  });

  it('истекшая регистрация — нет', () => {
    expect(isRegistered(line(30_000, -1), now)).toBe(false);
  });

  it('опрос давно не видел — нет: узел молчит или программа ушла', () => {
    expect(isRegistered(line(REGISTRATION_FRESH_MS + 1, 600_000), now)).toBe(false);
  });

  it('никогда не видели — нет', () => {
    expect(isRegistered(line(null, null), now)).toBe(false);
  });
});

describe('подключение шлюза или линии GOIP', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const device = (marks: { seenAgoMs?: number; knockedAgoMs?: number }) => ({
    registrationSeenAt:
      marks.seenAgoMs === undefined ? null : new Date(now.getTime() - marks.seenAgoMs),
    registrationExpiresAt: marks.seenAgoMs === undefined ? null : new Date(now.getTime() + 600_000),
    registrationAddress: '203.0.113.5:5060/udp',
    registeredAt:
      marks.knockedAgoMs === undefined ? null : new Date(now.getTime() - marks.knockedAgoMs),
  });

  it('вошло — на связи, с адресом', () => {
    expect(
      deviceConnection(device({ seenAgoMs: 30_000, knockedAgoMs: 60_000 }), now),
    ).toMatchObject({
      connected: true,
      address: '203.0.113.5:5060/udp',
      rejected: false,
    });
  });

  it('стучится, но не вошло — «проверьте пароль»; адрес прежней регистрации не показывается', () => {
    expect(
      deviceConnection(device({ seenAgoMs: REGISTRATION_FRESH_MS + 1, knockedAgoMs: 20_000 }), now),
    ).toMatchObject({ connected: false, address: null, rejected: true });
  });

  it('давно не стучалось — просто не на связи', () => {
    expect(deviceConnection(device({ knockedAgoMs: KNOCK_RECENT_MS + 1 }), now)).toMatchObject({
      connected: false,
      rejected: false,
    });
    expect(deviceConnection(device({}), now)).toMatchObject({
      connected: false,
      knocked_at: null,
      rejected: false,
    });
  });
});
