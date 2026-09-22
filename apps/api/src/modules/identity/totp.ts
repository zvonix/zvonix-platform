/**
 * Второй фактор по RFC 6238 ([ADR-0028](../../../../../docs/adr/0028-vtoroy-faktor.md)).
 *
 * Своя реализация, а не зависимость: криптографический примитив здесь не наш — HMAC-SHA1
 * берётся из `node:crypto`, — а наше только обвязка, восемьдесят строк. Правильность
 * проверяется не чтением кода, а **контрольными векторами из самого стандарта**:
 * они опубликованы в RFC 6238 и RFC 4648 и заведены в проверки.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Длина шага в секундах. Тридцать — то, что ожидают все приложения-аутентификаторы. */
export const TOTP_STEP_SECONDS = 30;

/** Сколько цифр в коде. Шесть — то же самое: другое значение люди введут неверно. */
const TOTP_DIGITS = 6;

/**
 * Сколько шагов допускается в обе стороны.
 *
 * Часы на телефоне уходят, и второй фактор, отвергающий верный код из-за пятнадцати
 * секунд расхождения, люди просто выключают.
 */
const TOTP_WINDOW_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Секрет в двадцать байт: столько же, сколько в контрольных векторах RFC 6238. */
const SECRET_BYTES = 20;

/** Новый секрет в base32 — в том виде, в каком его принимают аутентификаторы. */
export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(SECRET_BYTES));
}

/** Кодирование по RFC 4648 без выравнивания: аутентификаторы принимают и так. */
export function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += symbolAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) output += symbolAt((value << (5 - bits)) & 31);
  return output;
}

/**
 * Разбор base32.
 *
 * Пробелы и выравнивание отбрасываются, регистр не важен: человек вводит секрет руками
 * и переносит его глазами, а `jbsw y3dp` и `JBSWY3DP` — это одно и то же.
 */
export function decodeBase32(value: string): Buffer {
  const cleaned = value.replace(/[\s=]/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let accumulator = 0;

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error(`Недопустимый символ в base32: ${character}`);
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Номер шага, в который попадает момент. По нему же отсекается повторное использование. */
export function stepAt(at: Date, stepSeconds: number = TOTP_STEP_SECONDS): number {
  return Math.floor(at.getTime() / 1000 / stepSeconds);
}

/**
 * Код для конкретного шага.
 *
 * Алгоритм RFC 4226: HMAC-SHA1 от номера шага, динамическое усечение по младшему
 * полубайту и остаток от деления на десять в степени числа цифр.
 */
export function totpAt(secret: string, step: number, digits: number = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Проверяет код и возвращает шаг, в который он попал.
 *
 * Возвращается именно шаг, а не «да/нет»: вызывающий обязан запомнить его, иначе тот же
 * код примут второй раз в течение его тридцати секунд (RFC 6238, раздел 5.2).
 *
 * `minStep` отсекает уже использованные шаги: код из этого или более раннего шага
 * не принимается.
 */
export function verifyTotp(
  secret: string,
  code: string,
  at: Date,
  options: { minStep?: number; window?: number } = {},
): number | undefined {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d+$/.test(normalized) || normalized.length !== TOTP_DIGITS) return undefined;

  const window = options.window ?? TOTP_WINDOW_STEPS;
  const current = stepAt(at);

  for (let shift = -window; shift <= window; shift += 1) {
    const step = current + shift;
    if (options.minStep !== undefined && step <= options.minStep) continue;
    // Сравнение постоянного времени: сравнивать коды строкой значит сообщать длиной
    // совпадения, насколько близка попытка.
    if (equalCodes(totpAt(secret, step), normalized)) return step;
  }
  return undefined;
}

/** Ссылка `otpauth://`, из которой аутентификатор делает запись по снимку экрана. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/**
 * Символ алфавита по значению пятибитной группы.
 *
 * Индекс всегда в пределах алфавита — маска `& 31` это и обеспечивает, — но обращение
 * по индексу в строгом режиме даёт `string | undefined`, и молча складывать это
 * с ответом нельзя: молчаливое `undefined` в base32 — испорченный секрет.
 */
function symbolAt(index: number): string {
  const symbol = BASE32_ALPHABET[index];
  if (symbol === undefined) throw new Error(`Значение вне алфавита base32: ${String(index)}`);
  return symbol;
}

function equalCodes(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
