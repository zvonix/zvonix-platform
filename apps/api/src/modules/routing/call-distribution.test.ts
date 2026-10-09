import { DEFAULT_DISTRIBUTION, type DistributionSettings } from '@zvonix/shared';
import { describe, expect, it } from 'vitest';
import { arrangeByDistribution, type Placed } from './call-distribution.js';

const NOW = new Date('2026-10-09T12:00:00Z'); // 15:00 по Москве
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

interface Entry {
  readonly id: string;
  readonly placed: Placed;
}

function sim(id: string, patch: Partial<Placed> = {}): Entry {
  return {
    id,
    placed: {
      partnerId: 'p1',
      kind: 'sim',
      group: 'g1',
      lastRoutedAt: null,
      weight: 1,
      priority: 1,
      remaining: 1,
      ...patch,
    },
  };
}

const settings = (patch: Partial<DistributionSettings>): DistributionSettings => ({
  ...DEFAULT_DISTRIBUTION,
  ...patch,
});

const arrange = (entries: Entry[], patch: Partial<DistributionSettings> = {}): string[] =>
  arrangeByDistribution(
    entries,
    (entry) => entry.placed,
    () => settings(patch),
    NOW,
  ).map((entry) => entry.id);

describe('распределение звонков между картами партнёра', () => {
  it('«поровну»: давно не работавшая первой, ни разу не работавшая — перед всеми', () => {
    const list = [
      sim('a', { lastRoutedAt: ago(10) }),
      sim('b', { lastRoutedAt: ago(500) }),
      sim('c'),
    ];
    expect(arrange(list)).toEqual(['c', 'b', 'a']);
  });

  it('«по остатку»: у кого больше осталось лимита, тот первый', () => {
    const list = [
      sim('a', { remaining: 0.2 }),
      sim('b', { remaining: 0.9 }),
      sim('c', { remaining: 0.5 }),
    ];
    expect(arrange(list, { mode: 'remaining' })).toEqual(['b', 'c', 'a']);
  });

  it('«по очереди»: по номеру в списке, при равных остаётся порядок отбора', () => {
    const list = [sim('a', { priority: 3 }), sim('b', { priority: 1 }), sim('c', { priority: 1 })];
    expect(arrange(list, { mode: 'sequential' })).toEqual(['b', 'c', 'a']);
  });

  it('«по приоритету»: меньший номер первым, внутри номера — давно не работавшая', () => {
    const list = [
      sim('a', { priority: 2, lastRoutedAt: ago(900) }),
      sim('b', { priority: 1, lastRoutedAt: ago(10) }),
      sim('c', { priority: 1, lastRoutedAt: ago(300) }),
    ];
    expect(arrange(list, { mode: 'priority' })).toEqual(['c', 'b', 'a']);
  });

  it('«по весам»: простой, умноженный на вес — у кого больше, тот первый', () => {
    const heavyFirst = [
      sim('light', { weight: 1, lastRoutedAt: ago(100) }),
      sim('heavy', { weight: 3, lastRoutedAt: ago(60) }),
    ];
    expect(arrange(heavyFirst, { mode: 'weighted' })).toEqual(['heavy', 'light']);
    const lightFirst = [
      sim('heavy', { weight: 3, lastRoutedAt: ago(60) }),
      sim('light', { weight: 1, lastRoutedAt: ago(300) }),
    ];
    expect(arrange(lightFirst, { mode: 'weighted' })).toEqual(['light', 'heavy']);
  });

  it('другие партнёры, другая цена и транк не переставляются: порядок клиента и цены первичен', () => {
    const list = [
      sim('a', { lastRoutedAt: ago(10), group: 'g1' }),
      sim('other', { partnerId: 'p2', group: 'g2', lastRoutedAt: ago(5000) }),
      sim('b', { lastRoutedAt: ago(900), group: 'g3' }),
      { id: 'trunk', placed: { ...sim('x').placed, kind: 'sip' as const } },
    ];
    // Три разные группы, в каждой по одной карте: порядок не меняется.
    expect(arrange(list)).toEqual(['a', 'other', 'b', 'trunk']);
  });

  it('группа делится на подряд идущие участки: чужая строка между картами разрывает её', () => {
    const list = [
      sim('a', { lastRoutedAt: ago(10) }),
      sim('x', { partnerId: 'p2', group: 'g2' }),
      sim('b', { lastRoutedAt: ago(900) }),
    ];
    expect(arrange(list)).toEqual(['a', 'x', 'b']);
  });

  it('запас лимита: карта с остатком не больше запаса уходит в конец, а не отсекается', () => {
    const list = [sim('a', { remaining: 0.05 }), sim('b', { remaining: 0.9 })];
    expect(arrange(list, { reservePercent: 10 })).toEqual(['b', 'a']);
    expect(arrange(list, { reservePercent: 0 })).toEqual(['a', 'b']);
  });

  it('тихие часы: все карты партнёра остаются, но после карт других партнёров', () => {
    const list = [sim('a'), sim('other', { partnerId: 'p2', group: 'g2' })];
    const quiet = arrangeByDistribution(
      list,
      (entry) => entry.placed,
      (partnerId) =>
        partnerId === 'p1'
          ? settings({ quietFromMinute: 14 * 60, quietToMinute: 16 * 60 })
          : DEFAULT_DISTRIBUTION,
      NOW,
    ).map((entry) => entry.id);
    expect(quiet).toEqual(['other', 'a']);
  });

  it('список на выходе — те же элементы, что на входе', () => {
    const list = [sim('a'), sim('b', { remaining: 0 }), sim('c', { priority: 5 })];
    for (const mode of ['equal', 'remaining', 'sequential', 'weighted', 'priority'] as const) {
      expect(arrange(list, { mode, reservePercent: 20 }).sort()).toEqual(['a', 'b', 'c']);
    }
  });
});
