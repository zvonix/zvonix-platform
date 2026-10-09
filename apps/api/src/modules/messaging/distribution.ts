/**
 * Распределение, которое выбирает партнёр ([ADR-0080](../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)):
 * чистые функции — тихие часы и выбор аккаунта по режиму. Базы здесь нет, поэтому всё проверяется без неё.
 */

import type { DistributionMode } from '@zvonix/shared';
import type { AccountLoad } from './messages.repository.js';
import type { MessengerAccountRow } from './messaging.repository.js';
import { accountReadyAt, effectiveLimits } from './warmup.js';

/** Настройка партнёра; значения по умолчанию — «поровну» без параметров. */
export interface DistributionSettings {
  readonly mode: DistributionMode;
  readonly reservePercent: number;
  readonly quietFromMinute: number | null;
  readonly quietToMinute: number | null;
  readonly timezone: string;
  readonly stickyRecipient: boolean;
}

export const DEFAULT_DISTRIBUTION: DistributionSettings = {
  mode: 'equal',
  reservePercent: 0,
  quietFromMinute: null,
  quietToMinute: null,
  timezone: 'Europe/Moscow',
  stickyRecipient: false,
};

/** Минута суток в часовом поясе партнёра. Неизвестный пояс — UTC: лучше сдвиг, чем отказ отправки. */
export function minuteOfDay(now: Date, timezone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/** Когда кончатся тихие часы; `undefined` — сейчас не тихие часы (или их нет). Окно может переходить через полночь. */
export function quietEndsAt(settings: DistributionSettings, now: Date): Date | undefined {
  const { quietFromMinute: from, quietToMinute: to } = settings;
  if (from === null || to === null) return undefined;
  const current = minuteOfDay(now, settings.timezone);
  const inside = from < to ? current >= from && current < to : current >= from || current < to;
  if (!inside) return undefined;
  const minutesLeft = (to - current + 1440) % 1440 || 1440;
  return new Date(now.getTime() + minutesLeft * 60_000 - now.getUTCSeconds() * 1000);
}

/** Кандидат с нагрузкой: аккаунт и сколько он отправил/держит в очереди. */
export interface Candidate {
  readonly account: MessengerAccountRow;
  readonly load: AccountLoad;
}

/**
 * Свободен ли аккаунт под новое сообщение: не тихие часы, не на паузе, есть запас под лимиты с учётом очереди и
 * запаса партнёра.
 */
export function isFree(
  candidate: Candidate,
  settings: DistributionSettings,
  now: Date,
  paceSeconds: number,
): boolean {
  if (quietEndsAt(settings, now) !== undefined) return false;
  return (
    accountReadyAt(candidate.account, candidate.load, now, {
      paceSeconds,
      withBacklog: true,
      reservePercent: settings.reservePercent,
    }) === undefined
  );
}

/**
 * Лучший из свободных аккаунтов **одного партнёра** по его режиму. Порядок `candidates` — давно не работавшие
 * первыми (или по списку для режимов «по порядку» и «по приоритету»): при равных баллах побеждает более ранний.
 * Свободных нет — `undefined`.
 */
export function chooseByMode(
  candidates: readonly Candidate[],
  settings: DistributionSettings,
  now: Date,
  paceSeconds: number,
): Candidate | undefined {
  const free = candidates.filter((candidate) => isFree(candidate, settings, now, paceSeconds));
  if (free.length === 0) return undefined;
  // Меньший балл — лучше. Строгое «меньше» оставляет при равенстве более раннего кандидата.
  const score = (candidate: Candidate): number => {
    const { account, load } = candidate;
    const queued = load.day + load.backlog;
    switch (settings.mode) {
      case 'remaining': {
        const cap = effectiveLimits(account, now).daily;
        return cap === null ? -1e9 + queued : -(cap - queued);
      }
      case 'weighted':
        return queued / account.distributionWeight;
      case 'priority':
        return account.distributionPriority * 1e9 + load.backlog;
      case 'sequential':
        return 0; // первый свободный в порядке списка
      case 'equal':
        return load.backlog;
    }
  };
  let best = free[0];
  if (best === undefined) return undefined;
  let bestScore = score(best);
  for (const candidate of free.slice(1)) {
    const value = score(candidate);
    if (value < bestScore) {
      best = candidate;
      bestScore = value;
    }
  }
  return best;
}
