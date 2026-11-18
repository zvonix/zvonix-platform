/**
 * Доверенные адреса узла — готовым текстом для shell ([ADR-0125](../../../../../docs/adr/0125-svoi-adresa-ne-blokiruyutsya.md)).
 *
 * Пульс узла забирает его раз в 30 секунд и пишет в `ignoreip` обеих SIP-тюрем fail2ban: свои клиенты и партнёры
 * не блокируются за таймаут каталога. Формат такой, чтобы узлу не нужен был разбор: первая строка — метка (без неё
 * узел ответ не применяет), дальше адрес на строку — только цифры, точки и двоеточия, без повторов, по порядку
 * (одинаковый список даёт одинаковый текст, и узел не перечитывает fail2ban зря).
 */

import { isIP } from 'node:net';

/** Метка первой строки: по ней узел отличает список от страницы ошибки или прокси. */
export const TRUSTED_MARK = '# zvonix-trusted';

/** Сколько помнится адрес успешной регистрации. */
export const TRUSTED_FOR_MS = 7 * 24 * 60 * 60_000;

/**
 * Адрес из отметки регистрации `адрес:порт/транспорт` (`203.0.113.5:5060/udp`, IPv6 — `2001:db8::1:5060/udp`
 * или в скобках). Не похоже на адрес — `undefined`: в `ignoreip` уходит только проверенное.
 */
export function addressHost(address: string): string | undefined {
  const bare = address.split('/')[0]?.trim() ?? '';
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(bare);
  if (bracketed !== null) return isIP(bracketed[1] ?? '') === 6 ? bracketed[1] : undefined;
  const colon = bare.lastIndexOf(':');
  const withoutPort = colon === -1 ? bare : bare.slice(0, colon);
  if (isIP(withoutPort) !== 0) return withoutPort;
  // IPv6 без порта: последнее двоеточие — часть адреса.
  return isIP(bare) === 6 ? bare : undefined;
}

/** Текст ответа: метка и адреса без повторов, по порядку. */
export function trustedAddressesText(addresses: readonly string[]): string {
  const hosts = [
    ...new Set(addresses.map(addressHost).filter((host) => host !== undefined)),
  ].sort();
  return `${[TRUSTED_MARK, ...hosts].join('\n')}\n`;
}
