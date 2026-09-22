import { describe, expect, it } from 'vitest';
import { amountFor, bucketStart, limitInStoredUnits } from './limits.js';

const at = (iso: string) => new Date(iso);

describe('начало окна', () => {
  it.each([
    ['hour', '2026-09-03T14:37:52.123Z', '2026-09-03T14:00:00.000Z'],
    ['day', '2026-09-03T14:37:52.123Z', '2026-09-03T00:00:00.000Z'],
    ['month', '2026-09-03T14:37:52.123Z', '2026-09-01T00:00:00.000Z'],
  ] as const)('%s: %s → %s', (window, moment, expected) => {
    expect(bucketStart(window, at(moment)).toISOString()).toBe(expected);
  });

  it('неделя начинается с понедельника, а не с воскресенья', () => {
    // 2026-09-03 — четверг; неделя началась в понедельник 31 августа.
    expect(bucketStart('week', at('2026-09-03T14:00:00Z')).toISOString()).toBe(
      '2026-08-31T00:00:00.000Z',
    );
    // Воскресенье 6 сентября относится к той же неделе, а не к следующей.
    expect(bucketStart('week', at('2026-09-06T23:59:59Z')).toISOString()).toBe(
      '2026-08-31T00:00:00.000Z',
    );
    // Понедельник 7 сентября открывает следующую.
    expect(bucketStart('week', at('2026-09-07T00:00:00Z')).toISOString()).toBe(
      '2026-09-07T00:00:00.000Z',
    );
  });

  it('считает в UTC, а не в поясе машины', () => {
    // Иначе счётчик пишется в одно окно, а читается из другого — на машине разработчика
    // это незаметно, на сервере в другом поясе квота перестаёт работать.
    expect(bucketStart('day', at('2026-09-03T23:30:00Z')).toISOString()).toBe(
      '2026-09-03T00:00:00.000Z',
    );
    expect(bucketStart('day', at('2026-09-04T00:30:00Z')).toISOString()).toBe(
      '2026-09-04T00:00:00.000Z',
    );
  });

  it('момент ровно на границе принадлежит новому окну', () => {
    expect(bucketStart('hour', at('2026-09-03T15:00:00.000Z')).toISOString()).toBe(
      '2026-09-03T15:00:00.000Z',
    );
  });

  it('переход через год не ломает месяц', () => {
    expect(bucketStart('month', at('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(bucketStart('week', at('2026-01-01T12:00:00Z')).toISOString()).toBe(
      '2025-12-29T00:00:00.000Z',
    );
  });
});

describe('единицы метрики', () => {
  it('вызов стоит единицу в метрике звонков и свою длительность в минутах', () => {
    expect(amountFor('calls', 137)).toBe(1);
    expect(amountFor('minutes', 137)).toBe(137);
  });

  it('минуты задаются человеком, а копятся секундами', () => {
    // Иначе разговор в 90 секунд засчитался бы за одну минуту либо за полторы,
    // и обе трактовки были бы неверны на длинном хвосте.
    expect(limitInStoredUnits('minutes', 100)).toBe(6000);
    expect(limitInStoredUnits('calls', 100)).toBe(100);
  });
});
