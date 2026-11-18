import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isoDay } from './reports';
import {
  INCIDENT_PERIODS,
  LIST_PERIODS,
  listPeriodParams,
  listPeriodSearch,
  readListPeriod,
} from './list-period';

const from = (query: string) => {
  const search = new URLSearchParams(query);
  return (key: string) => search.get(key) ?? '';
};

describe('период в отборе списков', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 18, 0, 30, 15));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('по умолчанию — «Всё время», и оно первым среди кнопок', () => {
    expect(readListPeriod(from(''))).toEqual({ all: true });
    expect(LIST_PERIODS[0]?.label).toBe('Всё время');
    expect(INCIDENT_PERIODS.map((period) => period.label).slice(0, 3)).toEqual([
      'Всё время',
      'Час',
      'Сутки',
    ]);
    // У разбора вызовов «Сутки» вместо календарного «Сегодня».
    expect(INCIDENT_PERIODS.map((period) => period.label)).not.toContain('Сегодня');
  });

  it('старая ссылка с моментами «С/По» читается как сутки этих моментов', () => {
    const start = new Date(2026, 10, 1, 9, 15);
    const end = new Date(2026, 10, 17, 18, 40);
    const period = readListPeriod(
      from(
        `from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`,
      ),
    );
    expect(period).toEqual({ from: '2026-11-01', to: '2026-11-17' });
  });

  it('старая ссылка только с «С» — до сегодня; только с «По» — год до этой даты', () => {
    const start = new Date(2026, 10, 10, 12, 0).toISOString();
    expect(readListPeriod(from(`from=${encodeURIComponent(start)}`))).toEqual({
      from: '2026-11-10',
      to: isoDay(new Date()),
    });
    const end = new Date(2026, 10, 10, 12, 0).toISOString();
    expect(readListPeriod(from(`to=${encodeURIComponent(end)}`))).toEqual({
      from: '2025-11-10',
      to: '2026-11-10',
    });
  });

  it('испорченная дата в адресе — без отбора, а не ошибка', () => {
    expect(readListPeriod(from('from=вчера'))).toEqual({ all: true });
  });

  it('в адрес пишется ключ кнопки или свои сутки, прежние границы стираются', () => {
    expect(listPeriodParams({ all: true })).toEqual({ period: '', from: '', to: '' });
    expect(listPeriodParams({ hours: 24 })).toEqual({ period: '24h', from: '', to: '' });
    expect(listPeriodParams({ days: 7 })).toEqual({ period: '7', from: '', to: '' });
    expect(listPeriodParams({ from: '2026-11-01', to: '2026-11-03' })).toEqual({
      period: '',
      from: '2026-11-01',
      to: '2026-11-03',
    });
  });

  it('API получает моменты: «Сутки» — последние 24 часа от текущей минуты, не с полуночи', () => {
    const search = listPeriodSearch('period=24h&status=failed');
    expect(search.get('status')).toBe('failed');
    expect(search.get('period')).toBeNull();
    expect(search.get('from')).toBe(new Date(2026, 10, 17, 0, 30).toISOString());
    expect(search.get('to')).toBeNull();
  });

  it('свои сутки — с полуночи первых до полуночи после последних', () => {
    const search = listPeriodSearch('from=2026-11-01&to=2026-11-03');
    expect(search.get('from')).toBe(new Date(2026, 10, 1).toISOString());
    expect(search.get('to')).toBe(new Date(2026, 10, 4).toISOString());
  });

  it('«Всё время» — без границ', () => {
    const search = listPeriodSearch('destination=79001234567');
    expect(search.get('from')).toBeNull();
    expect(search.get('to')).toBeNull();
    expect(search.get('destination')).toBe('79001234567');
  });
});
