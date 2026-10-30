/**
 * Разброс паузы между звонками номера и сообщениями аккаунта
 * ([ADR-0106](../../../docs/adr/0106-rovnyy-temp-nomera-i-abonenty.md)).
 *
 * Одинаковые промежутки — признак программы, поэтому пауза удлиняется на случайную долю. Доля выводится из ключа, а
 * не берётся из `Math.random`: отбор кандидатов и проверка в транзакции обязаны прийти к одному ответу.
 */

import { minuteOfDay } from './distribution.js';

/** На какую долю пауза удлиняется самое большее: 30 с → 30–45 с. */
export const PACE_JITTER_SHARE = 0.5;

/**
 * Доля из `[0, 1)`, одна и та же для одного ключа: случайная на вид, воспроизводимая на деле. FNV-1a по символам и
 * финальное перемешивание MurmurHash3 — без него ключи, различные в последнем символе, давали близкие доли.
 */
export function paceJitter(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 2 ** 32;
}

/** Пауза в миллисекундах с разбросом по ключу: от `seconds` до `seconds × (1 + PACE_JITTER_SHARE)`. */
export function jitteredPauseMs(seconds: number, key: string): number {
  return Math.round(seconds * 1000 * (1 + PACE_JITTER_SHARE * paceJitter(key)));
}

/**
 * Сон номера и аккаунта ([ADR-0107](../../../docs/adr/0107-son-nomera-plokhoy-nomer-i-otchyot-blokirovok.md)): живой
 * человек ночью не звонит и не пишет. Начало сна своё у каждого ключа и разнесено по полосе 20:00–08:00 по Москве —
 * ночью спит около половины номеров, и площадка работает круглые сутки.
 */
export const SLEEP_TIMEZONE = 'Europe/Moscow';
const SLEEP_BAND_START_MINUTE = 20 * 60;
const SLEEP_BAND_MINUTES = 12 * 60;
const DAY_MINUTES = 24 * 60;

/** Когда ключ проснётся; `null` — не спит или сон выключен (`hours` ≤ 0). */
export function sleepUntil(key: string, hours: number, now: Date): Date | null {
  if (hours <= 0) return null;
  const length = Math.round(Math.min(hours, 24) * 60);
  const start =
    (SLEEP_BAND_START_MINUTE + Math.floor(paceJitter(`${key}:sleep`) * SLEEP_BAND_MINUTES)) %
    DAY_MINUTES;
  const into = (minuteOfDay(now, SLEEP_TIMEZONE) - start + DAY_MINUTES) % DAY_MINUTES;
  if (into >= length) return null;
  const minuteStart = now.getTime() - (now.getTime() % 60_000);
  return new Date(minuteStart + (length - into) * 60_000);
}
