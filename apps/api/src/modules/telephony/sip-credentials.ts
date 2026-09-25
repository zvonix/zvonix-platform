/**
 * Учётные данные SIP: имя, пароль и хеш для digest-проверки (ADR-0009).
 *
 * **Пароль не хранится нигде.** Хранится `a1-hash` — ровно то, чем SIP проверяет digest:
 * `MD5(имя:realm:пароль)`. FreeSWITCH принимает его в каталоге вместо пароля, поэтому
 * открытый пароль не нужен ни в базе, ни в ответе узлу.
 *
 * Честно про предел этой меры: обладание `a1-hash` равносильно знанию пароля **для входа
 * по SIP** — digest построен так, что больше ничего и не требуется. Мера защищает
 * не учётную запись, а сам пароль: он придуман нами, показан партнёру один раз и в базе
 * его нет, поэтому утечка таблицы не даёт строку, которую можно попробовать
 * где-то ещё. MD5 здесь — требование протокола SIP, а не выбор.
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Длина случайной части имени учётной записи. */
const USERNAME_CHARS = 12;

/** Алфавит имени: строчные буквы и цифры. Имя попадает в заголовки SIP и в логи узла. */
const USERNAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 24 байта в base64url — 32 символа. Пароль вводит человек в веб-интерфейс шлюза. */
const PASSWORD_BYTES = 24;

/** `port` — вход линии GOIP в режиме «каждая линия отдельно» (ADR-0054). */
export type SipPrincipalKind = 'gateway' | 'channel' | 'port';

/** Приставки разные у всех видов: имена разных видов не пересекаются по построению. */
const PREFIX: Readonly<Record<SipPrincipalKind, string>> = {
  gateway: 'gw',
  channel: 'ch',
  port: 'pt',
};

export interface SipCredentials {
  /** Имя учётной записи: `gw-a1b2c3d4e5f6`. Публично, попадает в заголовки SIP. */
  readonly username: string;
  /** Показывается один раз при выдаче. В базе его нет и восстановить неоткуда. */
  readonly password: string;
  /** `MD5(имя:realm:пароль)` — то, что уезжает на узел вместо пароля. */
  readonly a1Hash: string;
}

/**
 * Выпускает учётные данные.
 *
 * `realm` обязателен и общий на всю платформу: он входит в хеш, поэтому свой realm
 * у каждого узла означал бы, что учётная запись годится только на одном узле —
 * а перерегистрация на соседний это штатный способ пережить отказ узла.
 */
export function issueSipCredentials(kind: SipPrincipalKind, realm: string): SipCredentials {
  const username = issueSipUsername(kind);
  const password = randomBytes(PASSWORD_BYTES).toString('base64url');
  return { username, password, a1Hash: a1Hash(username, realm, password) };
}

/**
 * Только имя, без пароля.
 *
 * Нужно транку: к провайдеру регистрируемся мы, проверять digest нечего, и пароль
 * с хешем ему ни к чему. Имя при этом нужно — им транк зовётся исходящим sofia-gateway
 * на узле ([ADR-0039](../../../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)),
 * и оно обязано быть уникальным наравне с именами тех, кто регистрируется к нам.
 */
export function issueSipUsername(kind: SipPrincipalKind): string {
  return `${PREFIX[kind]}-${randomUsernameSuffix()}`;
}

/** `MD5(имя:realm:пароль)` — форма, заданная digest-проверкой SIP (RFC 2617, HA1). */
export function a1Hash(username: string, realm: string, password: string): string {
  return createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest('hex');
}

function randomUsernameSuffix(): string {
  let suffix = '';
  // `randomInt` уже без смещения: диапазон задаётся явно, а не остатком от байта.
  for (let i = 0; i < USERNAME_CHARS; i += 1) {
    suffix += USERNAME_ALPHABET.charAt(randomInt(USERNAME_ALPHABET.length));
  }
  return suffix;
}

/**
 * Экранирование значения для атрибута XML.
 *
 * Ответ узлу — XML, который собирается строкой: полноценный сериализатор ради четырёх
 * тегов избыточен. Но имя шлюза задаёт партнёр, и без экранирования кавычка в нём
 * ломает документ, а угловая скобка позволяет дописать в диалплан своё.
 */
export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
