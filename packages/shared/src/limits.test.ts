import { describe, expect, it } from 'vitest';
import { amountFor, bucketEnd, bucketStart, isTimeZone, limitInStoredUnits } from './limits.js';

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
    expect(amountFor('calls', { seconds: 137 })).toBe(1);
    expect(amountFor('minutes', { seconds: 137 })).toBe(137);
  });

  it('минуты задаются человеком, а копятся секундами', () => {
    // Иначе разговор в 90 секунд засчитался бы за одну минуту либо за полторы,
    // и обе трактовки были бы неверны на длинном хвосте.
    expect(limitInStoredUnits('minutes', 100)).toBe(6000);
    expect(limitInStoredUnits('calls', 100)).toBe(100);
  });
});

describe('окна партнёра (ADR-0057)', () => {
  it('минута начинается с нулевой секунды и кончается через шестьдесят', () => {
    expect(bucketStart('minute', at('2026-09-30T10:15:42.500Z')).toISOString()).toBe(
      '2026-09-30T10:15:00.000Z',
    );
    expect(bucketEnd('minute', at('2026-09-30T10:15:42.500Z')).toISOString()).toBe(
      '2026-09-30T10:16:00.000Z',
    );
  });

  it('пакет обновляется в свой день: до него окно ещё прошломесячное', () => {
    // Пакет с 15-го: 30 сентября — окно с 15 сентября, 3 октября — всё ещё оно же.
    expect(bucketStart('month', at('2026-09-30T12:00:00Z'), 15).toISOString()).toBe(
      '2026-09-15T00:00:00.000Z',
    );
    expect(bucketStart('month', at('2026-10-03T12:00:00Z'), 15).toISOString()).toBe(
      '2026-09-15T00:00:00.000Z',
    );
    expect(bucketEnd('month', at('2026-10-03T12:00:00Z'), 15).toISOString()).toBe(
      '2026-10-15T00:00:00.000Z',
    );
  });

  it('день обновления переходит через Новый год', () => {
    expect(bucketStart('month', at('2027-01-05T00:00:00Z'), 20).toISOString()).toBe(
      '2026-12-20T00:00:00.000Z',
    );
    expect(bucketEnd('month', at('2026-12-25T00:00:00Z'), 20).toISOString()).toBe(
      '2027-01-20T00:00:00.000Z',
    );
  });

  it('без дня обновления месяц — с первого числа, как прежде', () => {
    expect(bucketStart('month', at('2026-09-30T12:00:00Z')).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(bucketEnd('month', at('2026-12-31T23:59:59Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('конец окна — начало следующего у каждого окна', () => {
    const moment = at('2026-09-30T10:15:42Z');
    for (const window of ['minute', 'hour', 'day', 'week', 'month'] as const) {
      const end = bucketEnd(window, moment);
      expect(bucketStart(window, end).getTime()).toBe(end.getTime());
      expect(end.getTime()).toBeGreaterThan(moment.getTime());
    }
  });

  it('поминутный счёт округляет каждый разговор вверх до минуты', () => {
    // 61 секунда — две минуты пакета, как считает оператор, а не 1,02.
    expect(amountFor('minutes', { seconds: 61 }, 'minute')).toBe(120);
    expect(amountFor('minutes', { seconds: 60 }, 'minute')).toBe(60);
    expect(amountFor('minutes', { seconds: 1 }, 'minute')).toBe(60);
    expect(amountFor('minutes', { seconds: 0 }, 'minute')).toBe(0);
    expect(amountFor('minutes', { seconds: 61 }, 'second')).toBe(61);
    expect(amountFor('calls', { seconds: 61 }, 'minute')).toBe(1);
  });
});

describe('окна в поясе владельца (ADR-0102)', () => {
  it('сутки Новосибирска начинаются в его полночь — 17:00 UTC накануне', () => {
    const moment = at('2026-10-28T05:00:00Z'); // 12:00 по Новосибирску
    expect(bucketStart('day', moment, null, 'Asia/Novosibirsk').toISOString()).toBe(
      '2026-10-27T17:00:00.000Z',
    );
    expect(bucketEnd('day', moment, null, 'Asia/Novosibirsk').toISOString()).toBe(
      '2026-10-28T17:00:00.000Z',
    );
    // Через минуту после местной полуночи — уже новые сутки, хотя по UTC ещё вчера.
    expect(
      bucketStart('day', at('2026-10-28T17:01:00Z'), null, 'Asia/Novosibirsk').toISOString(),
    ).toBe('2026-10-28T17:00:00.000Z');
  });

  it('неделя — с местного понедельника, месяц — с местного числа обновления', () => {
    // Понедельник 26 октября 00:30 по Москве — это ещё воскресенье по UTC.
    const moment = at('2026-10-25T21:30:00Z');
    expect(bucketStart('week', moment, null, 'Europe/Moscow').toISOString()).toBe(
      '2026-10-25T21:00:00.000Z',
    );
    expect(
      bucketStart('month', at('2026-10-31T22:00:00Z'), null, 'Europe/Moscow').toISOString(),
    ).toBe('2026-10-31T21:00:00.000Z');
    expect(
      bucketStart('month', at('2026-10-10T12:00:00Z'), 15, 'Europe/Moscow').toISOString(),
    ).toBe('2026-09-14T21:00:00.000Z');
  });

  it('час в поясе с получасовым смещением — с местного часа', () => {
    // Индия +5:30: 10:15 UTC — 15:45 местного, час начался в 15:00 местного = 09:30 UTC.
    expect(
      bucketStart('hour', at('2026-10-28T10:15:00Z'), null, 'Asia/Kolkata').toISOString(),
    ).toBe('2026-10-28T09:30:00.000Z');
  });

  it('летнее время: сутки перевода длятся 23 и 25 часов, полночь остаётся полночью', () => {
    // Берлин: 29 марта 2026 часы вперёд, 25 октября 2026 — назад.
    const spring = at('2026-03-29T12:00:00Z');
    const springStart = bucketStart('day', spring, null, 'Europe/Berlin');
    const springEnd = bucketEnd('day', spring, null, 'Europe/Berlin');
    expect(springStart.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(springEnd.toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(springEnd.getTime() - springStart.getTime()).toBe(23 * 3_600_000);

    const autumn = at('2026-10-25T12:00:00Z');
    const autumnStart = bucketStart('day', autumn, null, 'Europe/Berlin');
    const autumnEnd = bucketEnd('day', autumn, null, 'Europe/Berlin');
    expect(autumnStart.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(autumnEnd.getTime() - autumnStart.getTime()).toBe(25 * 3_600_000);
  });

  it('полночи, которой не было, — окно с первого момента после перевода часов', () => {
    // Чили (Сантьяго): 6 сентября 2026 часы переводят с 00:00 сразу на 01:00.
    const start = bucketStart('day', at('2026-09-06T15:00:00Z'), null, 'America/Santiago');
    expect(start.toISOString()).toBe('2026-09-06T04:00:00.000Z');
  });

  it('конец окна — начало следующего в любом поясе', () => {
    for (const zone of ['Europe/Moscow', 'Asia/Kamchatka', 'Europe/Berlin', 'Asia/Kolkata']) {
      for (const window of ['minute', 'hour', 'day', 'week', 'month'] as const) {
        for (const iso of [
          '2026-03-29T00:30:00Z',
          '2026-10-25T01:30:00Z',
          '2026-12-31T23:59:00Z',
        ]) {
          const moment = at(iso);
          const end = bucketEnd(window, moment, null, zone);
          expect(bucketStart(window, end, null, zone).getTime()).toBe(end.getTime());
          expect(bucketStart(window, moment, null, zone).getTime()).toBeLessThanOrEqual(
            moment.getTime(),
          );
          expect(end.getTime()).toBeGreaterThan(moment.getTime());
        }
      }
    }
  });

  it('UTC — ровно прежние окна', () => {
    const moment = at('2026-09-03T14:37:52.123Z');
    for (const window of ['minute', 'hour', 'day', 'week', 'month'] as const) {
      expect(bucketStart(window, moment, null, 'UTC').getTime()).toBe(
        bucketStart(window, moment).getTime(),
      );
    }
  });

  it('пояс — только имя IANA', () => {
    expect(isTimeZone('Europe/Moscow')).toBe(true);
    expect(isTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    for (const bad of ['MSK', '+07:00', 'Europe/Атлантида', '', 'Europe/Moscow\nX']) {
      expect(isTimeZone(bad)).toBe(false);
    }
  });
});

describe('лимит денег (ADR-0102)', () => {
  it('копится микроединицами, задаётся рублями', () => {
    expect(amountFor('money', { seconds: 60, micros: 2_500_000 })).toBe(2_500_000);
    expect(amountFor('money', { seconds: 60 })).toBe(0);
    expect(limitInStoredUnits('money', 300)).toBe(300_000_000);
  });
});
