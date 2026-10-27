/**
 * Адрес SIP-провайдера, заведённого партнёром, — только внешний
 * ([ADR-0100](../../../../../docs/adr/0100-sip-provayder-partnyora-i-vklyuchenie-posle-proby.md), п. 2).
 *
 * По адресу транка узел площадки ходит сам: регистрируется и звонит. Петля, частная сеть или адрес нашего же узла
 * направили бы АТС во внутренние службы площадки или в петлю на саму себя. Имя проверяется по **каждому** адресу,
 * который отдаёт DNS: одного внутреннего среди внешних достаточно, чтобы узел однажды выбрал именно его.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** Сколько ждать DNS. Партнёр ждёт ответа формы, и минута тишины хуже внятного «адрес не найден». */
const LOOKUP_TIMEOUT_MS = 5000;

/** Адреса, которые не бывают адресом провайдера в интернете. */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

export type Lookup = (host: string) => Promise<string[]>;

/** Все адреса имени. Срок — `LOOKUP_TIMEOUT_MS`; не успел — как «не разрешилось». */
const systemLookup: Lookup = async (host) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('DNS не ответил вовремя'));
    }, LOOKUP_TIMEOUT_MS);
  });
  try {
    const found = await Promise.race([dnsLookup(host, { all: true, verbatim: true }), timeout]);
    return found.map((entry) => entry.address);
  } finally {
    clearTimeout(timer);
  }
};

/** Имя узла без порта: `sip.provider.ru:5070` → `sip.provider.ru`. IPv6 в адресе транка не принимает схема. */
export function hostOf(address: string): string {
  const colon = address.lastIndexOf(':');
  return colon === -1 ? address : address.slice(0, colon);
}

function isPublic(address: string): boolean {
  // IPv4 внутри IPv6 (`::ffff:10.0.0.1`) проверяется как IPv4: подсеть `::ffff:0:0/96` в списке накрыла бы и все
  // внешние адреса IPv4 — `BlockList` сопоставляет IPv4 с такими подсетями.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address)?.[1];
  if (mapped !== undefined) return isPublic(mapped);
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Все адреса узла или имени; IP отдаётся как есть, без DNS. */
async function addressesOf(host: string, lookup: Lookup): Promise<string[]> {
  return isIP(host) === 0 ? lookup(host) : [host];
}

/**
 * Что не так с адресом провайдера, или `undefined`, если он годится.
 *
 * `platformAddresses` — адреса SIP узлов площадки (с портом или без): транк на свой же узел — петля.
 */
export async function sipHostProblem(
  proxyHost: string,
  platformAddresses: readonly string[],
  lookup: Lookup = systemLookup,
): Promise<string | undefined> {
  const host = hostOf(proxyHost);
  let resolved: string[];
  try {
    resolved = await addressesOf(host, lookup);
  } catch {
    return 'Адрес не найден — проверьте, как он записан у провайдера';
  }
  if (resolved.length === 0) return 'Адрес не найден — проверьте, как он записан у провайдера';
  if (!resolved.every(isPublic)) {
    return 'Это внутренний адрес, а не адрес провайдера в интернете';
  }

  const own = new Set<string>();
  for (const address of platformAddresses) {
    try {
      for (const ip of await addressesOf(hostOf(address), lookup)) own.add(ip);
    } catch {
      // Адрес узла не разрешился — сравнивать не с чем, и это не повод отказать партнёру.
    }
  }
  if (resolved.some((ip) => own.has(ip))) {
    return 'Это адрес самой площадки, а не провайдера';
  }
  return undefined;
}
