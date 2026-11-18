/**
 * Решения о деньгах идущих разговоров (ADR-0125): пускать ли звонок и какие разговоры обрывать.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '@zvonix/shared';
import { callsToCut, elapsedSeconds, NODE_CALL_UUID, startAllowed } from './call-spend.js';

const rub = (value: string) => Money.fromMajorUnits(value);

describe('можно ли начать звонок', () => {
  it.each([
    ['10 копеек и без платы за соединение — можно', '0.10', '0', true],
    ['ровно ноль — нельзя', '0', '0', false],
    ['минус — нельзя', '-0.01', '0', false],
    ['хватает ровно на плату за соединение — можно', '1', '1', true],
    ['на плату за соединение не хватает — нельзя', '0.50', '1', false],
  ])('%s', (_name, headroom, connection, expected) => {
    expect(startAllowed(rub(headroom), rub(connection))).toBe(expected);
  });
});

describe('какие разговоры обрывать', () => {
  const call = (id: string, cost: string, cutOff = false) => ({ id, cost: rub(cost), cutOff });

  it('в пределе — ни одного', () => {
    expect(callsToCut(rub('10'), [call('новый', '1'), call('старый', '9')])).toEqual([]);
  });

  it('за пределом — самый новый, если без него остальные укладываются', () => {
    const cut = callsToCut(rub('10.50'), [call('новый', '1'), call('старый', '10')]);
    expect(cut.map((entry) => entry.id)).toEqual(['новый']);
  });

  it('новые по одному, пока не уложится', () => {
    const cut = callsToCut(rub('5'), [
      call('третий', '1'),
      call('второй', '2'),
      call('первый', '4'),
    ]);
    // 7 > 5 → без третьего 6 > 5 → без второго 4 ≤ 5.
    expect(cut.map((entry) => entry.id)).toEqual(['третий', 'второй']);
  });

  it('уже оборванный не обрывается второй раз, но его стоимость учитывается', () => {
    const cut = callsToCut(rub('5'), [call('оборванный', '2', true), call('старый', '4')]);
    // 6 > 5: оборванный пропущен, его 2 ₽ остаются в сумме — обрывается следующий.
    expect(cut.map((entry) => entry.id)).toEqual(['старый']);
  });

  it('доступное отрицательно — обрываются все', () => {
    const cut = callsToCut(rub('-1'), [call('новый', '0.01'), call('старый', '0.02')]);
    expect(cut.map((entry) => entry.id)).toEqual(['новый', 'старый']);
  });
});

describe('время идущего разговора', () => {
  const start = new Date('2026-11-18T10:00:00.000Z');

  it('с выдачи маршрута, целыми секундами вниз', () => {
    expect(elapsedSeconds(start, new Date('2026-11-18T10:01:30.900Z'))).toBe(90);
  });

  it('не меньше секунды: только что начатый звонок стоит плату за соединение и минимум', () => {
    expect(elapsedSeconds(start, start)).toBe(1);
    // Часы узла и площадки расходятся: «начало в будущем» не даёт отрицательной длительности.
    expect(elapsedSeconds(start, new Date('2026-11-18T09:59:59.000Z'))).toBe(1);
  });
});

describe('что уходит узлу в `uuid_kill`', () => {
  it.each([
    ['0198f3c4-1111-7000-8000-aaaaaaaaaaaa', true],
    ['0198F3C4-1111-7000-8000-AAAAAAAAAAAA', false],
    ['0198f3c4-1111-7000-8000-aaaaaaaaaaaa all', false],
    ['call-1-1763460000000', false],
    ['', false],
  ])('%s', (value, expected) => {
    expect(NODE_CALL_UUID.test(value)).toBe(expected);
  });
});
