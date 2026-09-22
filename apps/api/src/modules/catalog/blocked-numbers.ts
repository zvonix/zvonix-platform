/**
 * Разбор номера на префиксы для чёрного списка
 * ([ADR-0024](../../../../../docs/adr/0024-chyornyy-spisok-nomerov.md)).
 *
 * Отбор устроен наоборот, чем кажется: не «найти правило, под которое подходит номер»,
 * а «взять все префиксы номера и поискать их среди правил». Первое — это перебор таблицы
 * с `like` на каждый вызов, второе — восемь значений в `IN` по уникальному индексу.
 */

import type { Msisdn } from '@zvonix/shared';

/** Короче — это запрет всей страны (`7`) или всей мобильной связи (`79`). */
export const MIN_BLOCK_PREFIX_LENGTH = 4;

/** Длиннее номера префикса не бывает: одиннадцать цифр — это уже точный номер. */
export const MAX_BLOCK_PREFIX_LENGTH = 11;

/**
 * Все префиксы номера, которые может содержать чёрный список.
 *
 * Последний из них равен самому номеру: точный запрет — это префикс длиной одиннадцать,
 * отдельной формы записи для него нет.
 */
export function blockingPrefixesOf(msisdn: Msisdn): string[] {
  const prefixes: string[] = [];
  const limit = Math.min(msisdn.length, MAX_BLOCK_PREFIX_LENGTH);
  for (let length = MIN_BLOCK_PREFIX_LENGTH; length <= limit; length += 1) {
    prefixes.push(msisdn.slice(0, length));
  }
  return prefixes;
}
