/**
 * Шифрование секретов, которые нельзя хешировать
 * ([ADR-0028](../../../../docs/adr/0028-vtoroy-faktor.md)).
 *
 * Пароль хешируется — его достаточно сверить. Секрет второго фактора нужен в открытом
 * виде: без него нельзя вычислить код. Поэтому он шифруется ключом приложения, и смысл
 * ровно один: **утечка одной только базы не даёт генерировать коды**. Дамп базы — самый
 * вероятный способ утечки, а ключ живёт в конфигурации и в дамп не попадает.
 *
 * Цена названа в ADR: потеря `SECRET_KEY` означает потерю вторых факторов у всех.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** AES-256-GCM: шифрование с проверкой целостности — подменённый шифротекст не расшифруется. */
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/**
 * Назначения ключей.
 *
 * Ключ выводится из общего `SECRET_KEY` **с назначением**: ключ для секретов второго
 * фактора не должен совпадать с ключом для настроек площадки. Иначе одна утечка
 * шифротекста помогает разбирать другой.
 *
 * Строки не меняются никогда: сменить назначение — значит сменить ключ, а всё, что
 * им зашифровано, перестанет расшифровываться.
 */
export const TOTP_SECRET_PURPOSE = 'zvonix:totp-secret:v1';
export const PLATFORM_SETTING_PURPOSE = 'zvonix:platform-setting:v1';
export const SIP_TRUNK_SECRET_PURPOSE = 'zvonix:sip-trunk-secret:v1';
/** Не ключ шифрования, а ключ HMAC кода первого запуска (ADR-0050): назначение то же — разделить ключи. */
export const FIRST_RUN_CODE_PURPOSE = 'zvonix:first-run-code:v1';

/** Разделитель частей. Двоеточие в base64url не встречается. */
const SEPARATOR = ':';

export function encryptSecret(plain: string, appKey: string, purpose: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(appKey, purpose), nonce);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

  return [
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join(SEPARATOR);
}

/**
 * Расшифровывает секрет.
 *
 * Ошибка не проглатывается: невозможность расшифровать означает либо смену ключа, либо
 * порчу данных, и в обоих случаях второй фактор у человека **не работает** — молча
 * пустить его без кода значит отключить защиту, о которой он не знает.
 */
export function decryptSecret(stored: string, appKey: string, purpose: string): string {
  const parts = stored.split(SEPARATOR);
  if (parts.length !== 3) throw new Error('Зашифрованный секрет повреждён: не три части');

  const [nonce, tag, payload] = parts as [string, string, string];
  const decipher = createDecipheriv(
    ALGORITHM,
    deriveKey(appKey, purpose),
    Buffer.from(nonce, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(payload, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Ключ шифрования из ключа приложения.
 *
 * HKDF, а не сам `SECRET_KEY`: он задаётся человеком в конфигурации, то есть может быть
 * длиннее или короче нужного и распределён неравномерно. HKDF даёт из него ровно
 * тридцать два байта, пригодных для AES.
 */
export function deriveKey(appKey: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(appKey, 'utf8'), '', purpose, KEY_BYTES));
}
