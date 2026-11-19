import { describe, expect, it } from 'vitest';
import {
  channelConnection,
  channelEnabled,
  channelLastCall,
  hostOf,
  type ChannelStateInput,
  type ChannelViewer,
} from './channel-state.js';

// Время — по часам машины, на которой идут тесты: так же его показывает кабинет.
const NOW = new Date(2026, 10, 19, 12, 0);
const HOUR = 60 * 60 * 1000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

function line(overrides: Partial<ChannelStateInput> = {}): ChannelStateInput {
  return {
    status: 'active',
    suspended_by: null,
    connection: { connected: false, address: null },
    last_call_at: null,
    ...overrides,
  };
}

const connected = { connected: true, address: '94.198.51.21:5060/udp' };

describe('«Включена»', () => {
  const cases: [string, Partial<ChannelStateInput>, ChannelViewer, string, string][] = [
    ['включена', { status: 'active' }, 'client', 'ok', 'Да'],
    ['включена', { status: 'active' }, 'admin', 'ok', 'Да'],
    ['ждёт площадку', { status: 'pending' }, 'client', 'warn', 'Ждёт площадку'],
    ['ждёт площадку', { status: 'pending' }, 'admin', 'warn', 'Ждёт включения'],
    [
      'выключена клиентом',
      { status: 'suspended', suspended_by: 'client' },
      'client',
      'off',
      'Выключена вами',
    ],
    [
      'выключена клиентом',
      { status: 'suspended', suspended_by: 'client' },
      'admin',
      'off',
      'Выключена клиентом',
    ],
    [
      'выключена площадкой',
      { status: 'suspended', suspended_by: 'admin' },
      'client',
      'crit',
      'Выключена площадкой',
    ],
    [
      'выключена площадкой',
      { status: 'suspended', suspended_by: 'admin' },
      'admin',
      'crit',
      'Выключена площадкой',
    ],
    // Старая запись без отметки «кем» — как выключенная площадкой: клиент сам её не включит.
    ['выключена неизвестно кем', { status: 'suspended' }, 'client', 'crit', 'Выключена площадкой'],
    ['удалена', { status: 'closed' }, 'client', 'off', 'Удалена'],
    ['удалена', { status: 'closed' }, 'admin', 'off', 'Удалена'],
  ];

  it.each(cases)('%s — %s видит «%s/%s»', (_name, overrides, viewer, tone, label) => {
    const fact = channelEnabled(line(overrides), viewer);
    expect(fact.tone).toBe(tone);
    expect(fact.label).toBe(label);
  });

  it('у включённой линии пояснять нечего, у остальных — что делать', () => {
    expect(channelEnabled(line(), 'client').reason).toBeUndefined();
    expect(
      channelEnabled(line({ status: 'suspended', suspended_by: 'admin' }), 'client').reason,
    ).toContain('напишите в поддержку');
    expect(
      channelEnabled(line({ status: 'suspended', suspended_by: 'client' }), 'client').reason,
    ).toContain('на странице линии');
  });

  it('о включённости слова «подключена» нет', () => {
    for (const [, overrides, viewer] of cases) {
      expect(channelEnabled(line(overrides), viewer).label).not.toMatch(/подключ/i);
    }
  });
});

describe('«Подключение»', () => {
  it('есть — с адресом без порта, полный адрес в подсказке', () => {
    const fact = channelConnection(line({ connection: connected }), 'client', NOW);
    expect(fact).toEqual({
      tone: 'ok',
      label: 'Есть, с адреса 94.198.51.21',
      reason: 'Программа подключена с адреса 94.198.51.21:5060/udp',
    });
  });

  it('есть, но адрес неизвестен — просто «Есть»', () => {
    const fact = channelConnection(
      line({ connection: { connected: true, address: null } }),
      'admin',
      NOW,
    );
    expect(fact).toEqual({ tone: 'ok', label: 'Есть' });
  });

  it('нет, но звонили за сутки — без тревоги', () => {
    for (const viewer of ['client', 'admin'] as const) {
      const fact = channelConnection(line({ last_call_at: ago(23 * HOUR) }), viewer, NOW);
      expect(fact.tone).toBe('off');
      expect(fact.label).toBe('Нет');
      expect(fact.reason).toContain('без постоянного подключения');
    }
  });

  it('нет и не звонили сутки — жёлтым, клиенту подсказка, что ввести', () => {
    const client = channelConnection(line({ last_call_at: ago(25 * HOUR) }), 'client', NOW);
    expect(client).toEqual({
      tone: 'warn',
      label: 'Нет',
      reason: 'Введите в программе логин и пароль этой линии',
    });
    const admin = channelConnection(line({ last_call_at: ago(25 * HOUR) }), 'admin', NOW);
    expect(admin.tone).toBe('warn');
    expect(admin.reason).toContain('не звонила за последние сутки');
  });

  it('нет и не звонили никогда — жёлтым; поля нет в ответе — так же', () => {
    expect(channelConnection(line(), 'client', NOW).tone).toBe('warn');
    const { last_call_at: _omitted, ...withoutField } = line();
    expect(channelConnection(withoutField, 'client', NOW).tone).toBe('warn');
  });

  it('невключённой линии подключение не нужно — «Нет» без тревоги и без подсказки', () => {
    const states: Partial<ChannelStateInput>[] = [
      { status: 'pending' },
      { status: 'suspended', suspended_by: 'client' },
      { status: 'suspended', suspended_by: 'admin' },
      { status: 'closed' },
    ];
    for (const overrides of states) {
      expect(channelConnection(line(overrides), 'client', NOW)).toEqual({
        tone: 'off',
        label: 'Нет',
      });
    }
  });

  it('у невключённой линии, которая ещё держит регистрацию, подключение видно', () => {
    const fact = channelConnection(
      line({ status: 'suspended', suspended_by: 'client', connection: connected }),
      'client',
      NOW,
    );
    expect(fact.tone).toBe('ok');
  });

  it('прежний адрес отключившейся программы не показывается', () => {
    const fact = channelConnection(
      line({ connection: { connected: false, address: '94.198.51.21:5060/udp' } }),
      'client',
      NOW,
    );
    expect(fact.label).toBe('Нет');
  });
});

describe('«Последний вызов»', () => {
  it('день и время в этом году', () => {
    expect(
      channelLastCall(line({ last_call_at: new Date(2026, 10, 18, 20, 59).toISOString() }), NOW),
    ).toBe('18.11, 20:59');
  });

  it('с годом, если вызов в прошлом году', () => {
    expect(
      channelLastCall(line({ last_call_at: new Date(2025, 11, 31, 9, 5).toISOString() }), NOW),
    ).toBe('31.12.2025, 09:05');
  });

  it('прочерк, если звонков не было или поля нет', () => {
    expect(channelLastCall(line(), NOW)).toBe('—');
    const { last_call_at: _omitted, ...withoutField } = line();
    expect(channelLastCall(withoutField, NOW)).toBe('—');
  });
});

describe('адрес без порта', () => {
  it.each([
    ['94.198.51.21:5060/udp', '94.198.51.21'],
    ['94.198.51.21:5060', '94.198.51.21'],
    ['94.198.51.21', '94.198.51.21'],
    ['94.198.51.21/tcp', '94.198.51.21'],
    ['[2001:db8::1]:5060/udp', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
  ])('%s → %s', (address, host) => {
    expect(hostOf(address)).toBe(host);
  });
});
