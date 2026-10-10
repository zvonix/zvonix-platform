/**
 * Распределение, которое выбирает партнёр ([ADR-0080](../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)):
 * настройка и тихие часы. Общие для звонков и сообщений MAX, поэтому лежат здесь; базы и времени «сейчас» здесь нет.
 */

import type { DistributionMode } from './messaging.js';

/**
 * Приоритеты партнёров у клиента ([ADR-0081](../../../docs/adr/0081-prioritety-partnyorov-u-klienta.md)).
 * Предложение: звонок через SIM, звонок через SIP-транк или сообщение MAX.
 */
export const CLIENT_PRIORITY_OFFERS = ['sim', 'sip', 'message'] as const;
export type ClientPriorityOffer = (typeof CLIENT_PRIORITY_OFFERS)[number];

/** Цифра приоритета: 1 — первыми; одинаковая у нескольких — поочерёдно. */
export const CLIENT_PRIORITY_MAX = 99;

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
