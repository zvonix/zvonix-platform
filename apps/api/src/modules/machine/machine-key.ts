/**
 * Ключи машинного доступа: выпуск, разбор заголовка, сравнение (ADR-0019).
 *
 * Отдельно от сессий людей намеренно, хотя механика похожа: у машин другой срок жизни,
 * другой способ предъявления и другой субъект. Общая функция «проверь секрет» на два
 * разных набора правил однажды пропустит человеческую роль по ключу узла.
 *
 * Секрет хранится как SHA-256. Argon2 здесь недопустим: проверка выполняется на каждый
 * звонок, а перебирать 256 бит случайности всё равно нечего.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { keyIdTag, type MachineKeyKind } from '@zvonix/shared';

/** 32 байта — 256 бит энтропии, как у токена сессии. */
const SECRET_BYTES = 32;

/** Длина видимой части идентификатора. Достаточно, чтобы не совпасть, и коротко для лога. */
const KEY_ID_CHARS = 12;

/** Одноразовый токен установки живёт час: за это время скрипт успевает, а утечка — нет. */
export const ENROLLMENT_TTL_MS = 60 * 60 * 1000;

/** Срок клиентского ключа. У ключей узлов срока нет — см. ADR-0019. */
export const CLIENT_KEY_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Реже, чем `last_used_at` обновляется: иначе каждый звонок пишет в базу. */
export const LAST_USED_REFRESH_MS = 5 * 60 * 1000;

export interface IssuedKey {
  /** Публичная часть. Ищется по индексу, безопасна в логах. */
  readonly keyId: string;
  /** Отдаётся один раз и больше нигде не хранится. */
  readonly secret: string;
  readonly secretHash: string;
}

export function issueKey(kind: MachineKeyKind): IssuedKey {
  // base64url даёт буквы обоих регистров; идентификатор приводится к нижнему,
  // потому что его читают вслух и переписывают руками.
  const suffix = randomBytes(KEY_ID_CHARS)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(0, KEY_ID_CHARS);
  const secret = randomBytes(SECRET_BYTES).toString('base64url');

  return {
    keyId: `zvx_${keyIdTag(kind)}_${suffix}`,
    secret,
    secretHash: hashSecret(secret),
  };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export interface PresentedKey {
  readonly keyId: string;
  readonly secret: string;
}

/**
 * Разбирает заголовок `Authorization` в обоих принятых видах.
 *
 * `Basic base64(id:secret)` — единственное, что умеет FreeSWITCH: `mod_xml_curl`
 * и `mod_json_cdr` задают только `user:pass`, произвольный заголовок им недоступен.
 * `Bearer <id>.<secret>` — для нашего собственного агента, который заголовок задать умеет.
 *
 * Схема одна, кодировок две. Разделители выбраны так, что разбор однозначен: секрет —
 * base64url, в его алфавите нет ни `:`, ни `.`.
 */
export function readMachineKey(header: string | undefined): PresentedKey | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();

  const basic = /^Basic (\S+)$/.exec(trimmed)?.[1];
  if (basic !== undefined) {
    let decoded: string;
    try {
      decoded = Buffer.from(basic, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
    return split(decoded, ':');
  }

  const bearer = /^Bearer (\S+)$/.exec(trimmed)?.[1];
  if (bearer !== undefined) return split(bearer, '.');

  return undefined;
}

function split(value: string, separator: string): PresentedKey | undefined {
  const at = value.indexOf(separator);
  if (at <= 0) return undefined;
  const keyId = value.slice(0, at);
  const secret = value.slice(at + separator.length);
  if (secret === '') return undefined;
  return { keyId, secret };
}

/**
 * Сравнение хешей за постоянное время.
 *
 * Поиск идёт по индексу и сам утечкой не является, но там, где два секрета сравниваются
 * в коде, обычное `===` завершается на первом различии и выдаёт по времени совпавший префикс.
 */
export function secretHashEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Приводит адрес к сравнимому виду.
 *
 * IPv4, пришедший по IPv6-сокету, выглядит как `::ffff:192.0.2.1`. Без приведения список
 * разрешённых адресов, заполненный человеком в привычном виде, не совпал бы никогда —
 * и это отказ телефонии, а не отказ в доступе злоумышленнику.
 */
export function normalizeIp(ip: string): string {
  const lower = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  return mapped?.[1] ?? lower;
}

/** Пустой список означает «откуда угодно» (ADR-0019). */
export function ipAllowed(allowed: readonly string[], ip: string | undefined): boolean {
  if (allowed.length === 0) return true;
  if (ip === undefined) return false;
  const normalized = normalizeIp(ip);
  return allowed.some((entry) => normalizeIp(entry) === normalized);
}
