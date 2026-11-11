/**
 * Адрес SIP узла по адресу его обращения к площадке (ADR-0113).
 */

/** Петля: обращение с той же машины. */
function isLoopback(ip: string): boolean {
  const bare = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  return bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(bare);
}

/**
 * Адрес, на который партнёры и клиенты направляют SIP, — по адресу, с которого узел обратился к площадке
 * ([ADR-0113](../../../../../docs/adr/0113-adres-sip-uzla-sam-i-bez-podmeny.md)).
 *
 * Петля — узел на машине площадки, и снаружи до него тот же домен, что у сайта. Частный адрес снаружи
 * недоступен — `undefined`: такой адрес задаёт администратор, угадывать его нельзя.
 */
export function detectSipAddress(
  ip: string | undefined,
  publicBaseUrl: string,
): string | undefined {
  if (ip === undefined || ip === '') return undefined;
  if (isLoopback(ip)) return new URL(publicBaseUrl).hostname;
  const bare = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u.exec(bare);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    const internal =
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254);
    return internal ? undefined : bare;
  }
  const lower = bare.toLowerCase();
  if (/^f[cd]/u.test(lower) || lower.startsWith('fe80')) return undefined;
  return bare.includes(':') ? bare : undefined;
}
