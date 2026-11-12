/**
 * Проверка адреса SIP узла: куда ведёт его имя и туда ли, где стоит узел
 * ([ADR-0113](../../../../../docs/adr/0113-adres-sip-uzla-sam-i-bez-podmeny.md), ревизия 2026-11-11).
 *
 * Владелец: «в настройках АТС показывать, есть ли запись, и чтобы сайт сам проверял». Имя в GOIP лучше цифр:
 * переехал узел — меняется одна DNS-запись, а не настройки каждой линии у каждого партнёра. Поэтому проверка
 * не только говорит «верно» или «нет», но и называет запись, которую нужно завести, — готовой к копированию.
 */

import { isIP } from 'node:net';
import { detectSipAddress } from './sip-address.js';

/** Чем закончилась проверка. */
type SipCheckVerdict =
  /** Имя ведёт туда, где стоит узел. */
  | 'ok'
  /** Имя есть, но ведёт на другой адрес. */
  | 'mismatch'
  /** Такого имени в DNS нет. */
  | 'missing'
  /** Указан IP узла: работает, но имя удобнее. */
  | 'ip'
  /** Указан IP, но не тот, с которого узел обращается к площадке. */
  | 'ip_mismatch'
  /** Адрес не задан. */
  | 'none'
  /** Где стоит узел, площадка не знает (не обращался или за NAT) — сравнить не с чем. */
  | 'unverifiable'
  /** DNS не ответил вовремя. */
  | 'error';

export interface SipCheck {
  readonly verdict: SipCheckVerdict;
  /** Проверенный адрес — как задан, с портом, если он был. */
  readonly address: string | null;
  /** Куда ведёт имя: адреса A и AAAA. */
  readonly resolved: readonly string[];
  /** Адреса, на которые имя должно вести: адрес узла (или сайта, если узел на его машине). */
  readonly expected: readonly string[];
  /** Какую запись завести у регистратора; `null` — подсказывать нечего (адрес узла неизвестен). */
  readonly record: {
    readonly name: string;
    readonly type: 'A' | 'AAAA';
    readonly value: string;
  } | null;
  /** Ответ дали главные серверы домена — то, что заведено у регистратора; `false` — только DNS сервера. */
  readonly authoritative: boolean;
  /**
   * DNS сервера площадки ещё помнит другие адреса — запись недавно меняли. Обновится сам через
   * `expiresInSeconds` (`null` — срок неизвестен). Пока не обновится, GOIP, спросившие тот же кэш,
   * могут уходить по старому адресу.
   */
  readonly stale: {
    readonly addresses: readonly string[];
    readonly expiresInSeconds: number | null;
  } | null;
}

/** Ответ DNS об имени: адреса (`undefined` — записи нет), чей ответ и что ещё помнит кэш. */
export interface NameAnswer {
  readonly addresses: readonly string[] | undefined;
  readonly authoritative: boolean;
  readonly stale: SipCheck['stale'];
}

/** Разрешение имени. Не ответил ни один DNS — исключение. */
export type ResolveName = (name: string) => Promise<NameAnswer>;

/** Имя без порта: `sip.zvonix.com:5070` → `sip.zvonix.com`, `[2001:db8::1]:5060` → `2001:db8::1`. */
export function hostOf(address: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(address);
  if (bracketed?.[1] !== undefined) return bracketed[1];
  if (isIP(address) === 6) return address;
  const colon = address.lastIndexOf(':');
  return colon > 0 ? address.slice(0, colon) : address;
}

/**
 * Имя, которое предлагается завести: `sip.` + домен сайта без первой части.
 * `cp.zvonix.com` → `sip.zvonix.com`; `zvonix.com` → `sip.zvonix.com`; сайт по IP — `null`.
 */
export function suggestedName(siteHost: string): string | null {
  if (isIP(siteHost) !== 0 || !siteHost.includes('.')) return null;
  const labels = siteHost.split('.');
  const apex = labels.length > 2 ? labels.slice(1).join('.') : siteHost;
  return `sip.${apex}`;
}

/**
 * Проверяет адрес SIP узла.
 *
 * Где стоит узел: адрес его последнего обращения. С машины площадки (петля) — там же, где сайт: тогда имя
 * должно вести туда же, куда домен сайта. Частный адрес снаружи не виден — сравнить не с чем.
 */
export async function checkSipAddress(input: {
  readonly address: string | null;
  readonly nodeAddress: string | null;
  readonly publicBaseUrl: string;
  readonly resolve: ResolveName;
}): Promise<SipCheck> {
  const siteHost = new URL(input.publicBaseUrl).hostname;
  const detected = detectSipAddress(input.nodeAddress ?? undefined, input.publicBaseUrl);

  // Ожидаемые адреса: публичный адрес узла — он; узел на машине сайта — куда ведёт домен сайта.
  let expected: readonly string[] = [];
  if (detected !== undefined) {
    expected =
      isIP(detected) !== 0
        ? [detected]
        : ((await safeResolve(input.resolve, siteHost))?.addresses ?? []);
  }

  // Запись — для имени, которое вписано: его и надо исправить. Вписан IP или ничего — предлагается имя
  // от домена сайта: `cp.zvonix.com` → `sip.zvonix.com`.
  const typedHost = input.address === null ? null : hostOf(input.address);
  const suggested =
    typedHost !== null && isIP(typedHost) === 0 ? typedHost.toLowerCase() : suggestedName(siteHost);
  const target = expected[0];
  const record =
    suggested !== null && target !== undefined
      ? {
          name: suggested,
          type: isIP(target) === 6 ? ('AAAA' as const) : ('A' as const),
          value: target,
        }
      : null;
  const result = (
    verdict: SipCheckVerdict,
    resolved: readonly string[] = [],
    answer?: NameAnswer,
  ): SipCheck => ({
    verdict,
    address: input.address,
    resolved,
    expected,
    record,
    authoritative: answer?.authoritative ?? false,
    stale: answer?.stale ?? null,
  });

  if (input.address === null) return result('none');
  const host = hostOf(input.address);

  if (isIP(host) !== 0) {
    if (expected.length === 0) return result('unverifiable', [host]);
    return result(expected.includes(host) ? 'ip' : 'ip_mismatch', [host]);
  }

  let answer: NameAnswer;
  try {
    answer = await input.resolve(host);
  } catch {
    return result('error');
  }
  const resolved = answer.addresses;
  if (resolved === undefined || resolved.length === 0) return result('missing', [], answer);
  if (expected.length === 0) return result('unverifiable', resolved, answer);
  return result(resolved.some((ip) => expected.includes(ip)) ? 'ok' : 'mismatch', resolved, answer);
}

async function safeResolve(resolve: ResolveName, name: string): Promise<NameAnswer | undefined> {
  try {
    return await resolve(name);
  } catch {
    return undefined;
  }
}
