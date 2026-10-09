/**
 * Распределение звонков между картами партнёра ([ADR-0080](../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)).
 *
 * Чистая функция над уже выстроенным списком кандидатов: клиентский приоритет и цена остаются первыми
 * ([ADR-0040](../../../../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)), а внутри **одинакового**
 * (приоритет, цена, партнёр) карты переставляются по режиму партнёра. Звонок ждать не может, поэтому запас лимита и
 * тихие часы действуют мягко: такие карты уходят в конец перебора, а не отсекаются.
 */

import { quietEndsAt, type DistributionSettings } from '@zvonix/shared';

/** Что о кандидате надо знать распределению; остальное — забота вызывающего. */
export interface Placed {
  readonly partnerId: string;
  /** `sim` — карта; `sip` (транк) карты не имеет и не переставляется. */
  readonly kind: 'sim' | 'sip';
  /** Одинаковый ключ — одна группа: клиентский приоритет, цена и партнёр совпали. */
  readonly group: string;
  readonly lastRoutedAt: Date | null;
  readonly weight: number;
  readonly priority: number;
  /** Доля остатка самого строгого лимита карты, 0–1; 1 — лимитов нет. */
  readonly remaining: number;
}

/** Давно не работавшая — первой; ни разу — перед всеми. */
const byRecency = (left: Placed, right: Placed): number =>
  (left.lastRoutedAt?.getTime() ?? Number.NEGATIVE_INFINITY) -
  (right.lastRoutedAt?.getTime() ?? Number.NEGATIVE_INFINITY);

/** Порядок внутри группы по режиму; `Array.sort` устойчив: при равенстве остаётся порядок отбора. */
function sortRun<T>(
  run: T[],
  describe: (entry: T) => Placed,
  settings: DistributionSettings,
  now: Date,
): void {
  const compare = (left: T, right: T): number => {
    const a = describe(left);
    const b = describe(right);
    switch (settings.mode) {
      case 'equal':
        return byRecency(a, b);
      case 'remaining':
        return b.remaining - a.remaining || byRecency(a, b);
      case 'sequential':
        return a.priority - b.priority;
      case 'priority':
        return a.priority - b.priority || byRecency(a, b);
      case 'weighted': {
        // Взвешенное чередование: чем дольше карта простаивает и чем больше её вес, тем раньше её очередь.
        const age = (placed: Placed): number =>
          placed.lastRoutedAt === null
            ? Number.POSITIVE_INFINITY
            : (now.getTime() - placed.lastRoutedAt.getTime()) * placed.weight;
        const left_ = age(a);
        const right_ = age(b);
        if (left_ === right_) return 0;
        return left_ > right_ ? -1 : 1;
      }
    }
  };
  run.sort(compare);
}

/**
 * Перестановка кандидатов по настройкам партнёров. Запрещённых звонков не создаёт и никого не отсекает: список на
 * выходе — те же элементы, что на входе.
 */
export function arrangeByDistribution<T>(
  entries: readonly T[],
  describe: (entry: T) => Placed,
  settingsOf: (partnerId: string) => DistributionSettings,
  now: Date,
): T[] {
  // 1. Группы подряд идущих карт одного партнёра с одним приоритетом и ценой.
  const arranged: T[] = [];
  let run: T[] = [];
  let runKey: string | undefined;
  const flush = () => {
    const first = run[0];
    if (first !== undefined && run.length > 1) {
      sortRun(run, describe, settingsOf(describe(first).partnerId), now);
    }
    arranged.push(...run);
    run = [];
  };
  for (const entry of entries) {
    const placed = describe(entry);
    const key = placed.kind === 'sim' ? placed.group : undefined;
    if (key === undefined || key !== runKey) {
      flush();
      runKey = key;
    }
    run.push(entry);
  }
  flush();

  // 2. Мягкие правила: карта в тихих часах или с исчерпанным запасом уходит в конец перебора, остальное не меняется.
  const preferred: T[] = [];
  const demoted: T[] = [];
  // Тихие часы считаются один раз на партнёра: пояс разбирается через Intl, и на тысячах карт это заметно.
  const resting = new Map<string, boolean>();
  for (const entry of arranged) {
    const placed = describe(entry);
    const settings = settingsOf(placed.partnerId);
    let asleep = resting.get(placed.partnerId);
    if (asleep === undefined) {
      asleep = quietEndsAt(settings, now) !== undefined;
      resting.set(placed.partnerId, asleep);
    }
    const reserved =
      settings.reservePercent > 0 && placed.remaining * 100 <= settings.reservePercent;
    (placed.kind === 'sim' && (asleep || reserved) ? demoted : preferred).push(entry);
  }
  return [...preferred, ...demoted];
}
