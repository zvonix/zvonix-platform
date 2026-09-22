/**
 * Код первого запуска ([ADR-0050](../../../../../docs/adr/0050-ustanovka-odnoy-komandoy-i-pervyy-vhod.md)).
 *
 * Пока на площадке нет администратора, кабинет заводит его по коду, который видит только
 * тот, кто запускал установку: код печатает выкладка. Без кода правило «кто первым открыл —
 * тот администратор» отдавало бы площадку первому, кто узнал адрес.
 *
 * Код не хранится, а **выводится** из `SECRET_KEY`: HMAC ключом с отдельным назначением
 * от номера суток UTC. Хранить было бы негде без лишнего: таблица — это миграция ради одной
 * строки, Redis теряет ключ при перезапуске. Вычислить код может только владелец
 * `SECRET_KEY` — root на сервере, который площадкой и так владеет.
 *
 * Принимаются коды текущих и прошлых суток: код, напечатанный за минуту до полуночи,
 * не должен сгореть через минуту. Живёт он от суток до двух.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveKey, FIRST_RUN_CODE_PURPOSE } from '../../infra/secret-box.js';
import { encodeBase32 } from './totp.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Двенадцать знаков base32 — шестьдесят бит: перебором не берутся и при недоступном пределе частоты. */
const CODE_LENGTH = 12;

const dayOf = (at: Date): number => Math.floor(at.getTime() / DAY_MS);

function codeForDay(appKey: string, day: number): string {
  const digest = createHmac('sha256', deriveKey(appKey, FIRST_RUN_CODE_PURPOSE))
    .update(`day:${String(day)}`)
    .digest();
  return encodeBase32(digest).slice(0, CODE_LENGTH);
}

/**
 * Код для показа — группами по четыре, чтобы его можно было переписать с экрана, —
 * и момент, до которого его примут.
 */
export function firstRunCode(appKey: string, at: Date): { code: string; validUntil: Date } {
  const day = dayOf(at);
  const raw = codeForDay(appKey, day);
  return {
    code: `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`,
    validUntil: new Date((day + 2) * DAY_MS),
  };
}

/**
 * Подходит ли введённый код.
 *
 * Регистр, пробелы и дефисы не важны — человек переписывает код руками. Сравниваются оба
 * допустимых кода и без раннего выхода: время ответа не должно подсказывать, какой из них
 * совпал и совпал ли хоть сколько-то знаков.
 */
export function acceptsFirstRunCode(appKey: string, input: string, now: Date): boolean {
  const given = Buffer.from(input.toUpperCase().replace(/[\s-]/gu, ''), 'utf8');
  const day = dayOf(now);
  let accepted = false;
  for (const candidate of [day, day - 1]) {
    const expected = Buffer.from(codeForDay(appKey, candidate), 'utf8');
    if (given.length === expected.length && timingSafeEqual(given, expected)) accepted = true;
  }
  return accepted;
}
