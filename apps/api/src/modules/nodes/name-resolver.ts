/**
 * Разрешение имени адреса SIP (ADR-0113, ревизии «проверка DNS» и «главные серверы домена»).
 *
 * Правда о записи — у **главных серверов домена** (NS зоны): то, что владелец завёл у регистратора.
 * DNS хостинга, которым пользуется сервер площадки, держит ответы в памяти до часа и после правки записи
 * ещё отдаёт старый адрес. Первая проверка спрашивала только его и сказала «ведёт не туда» о записи,
 * которая уже была верной: хостинг помнил 78.17.98.160, а главные серверы и весь мир видели
 * 217.197.114.163 (владелец, 2026-11-12: «ты уверен, что правильно проверяет?»).
 *
 * Поэтому ответ — от главных серверов, а память DNS сервера показывается отдельно, если отличается:
 * с остатком срока, через который она сама обновится. Если главные серверы недоступны (нет NS, закрыт
 * порт 53) — ответ DNS сервера, как прежде, и `authoritative: false`.
 *
 * Сроки короткие: окно настроек ждёт ответа. Ответ помнится минуту; «Проверить снова» минует память.
 */

import { lookup, Resolver } from 'node:dns/promises';
import { Injectable } from '@nestjs/common';
import type { NameAnswer } from './sip-dns.js';

/** Сколько помнить ответ. */
const CACHE_MS = 60_000;
/** Срок одного запроса к DNS и число попыток. */
const TIMEOUT_MS = 2000;
const TRIES = 1;
/** Предел на всю проверку имени: несколько запросов подряд не должны держать окно дольше. */
const TOTAL_MS = 6000;

/** Ответы, которые значат «такого имени или записей нет», а не «DNS не ответил». */
const ABSENT = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'EAI_NONAME', 'EAI_NODATA']);

@Injectable()
export class NameResolver {
  private readonly cache = new Map<string, { at: number; answer: NameAnswer }>();

  /** Что известно об имени. Не ответил ни один DNS — исключение. */
  async resolve(name: string, fresh = false): Promise<NameAnswer> {
    const key = name.toLowerCase();
    const cached = this.cache.get(key);
    if (!fresh && cached !== undefined && Date.now() - cached.at < CACHE_MS) {
      return aged(cached.answer, Date.now() - cached.at);
    }
    const answer = await withTimeout(this.ask(key), TOTAL_MS);
    this.cache.set(key, { at: Date.now(), answer });
    return answer;
  }

  private async ask(name: string): Promise<NameAnswer> {
    const [truth, local] = await Promise.all([
      this.fromZone(name).catch(() => null),
      this.fromServer(name),
    ]);
    if (truth === null) return { addresses: local.addresses, authoritative: false, stale: null };
    const differs = local.addresses !== undefined && !sameSet(local.addresses, truth ?? []);
    return {
      addresses: truth,
      authoritative: true,
      stale:
        differs && local.addresses !== undefined
          ? { addresses: local.addresses, expiresInSeconds: local.ttl }
          : null,
    };
  }

  /**
   * Ответ главных серверов домена: зона ищется подъёмом по имени (`sip.zvonix.com` → `zvonix.com`), её NS —
   * адресами, запрос — к ним напрямую. `undefined` — записи нет; исключение — главные серверы не нашлись
   * или не ответили.
   */
  private async fromZone(name: string): Promise<readonly string[] | undefined> {
    const system = new Resolver({ timeout: TIMEOUT_MS, tries: TRIES });
    const labels = name.split('.');
    let servers: string[] | undefined;
    for (let start = 0; start < labels.length - 1 && servers === undefined; start += 1) {
      const zone = labels.slice(start).join('.');
      try {
        const ns = await system.resolveNs(zone);
        if (ns.length > 0) servers = ns;
      } catch (cause) {
        if (!ABSENT.has(codeOf(cause))) throw cause;
      }
    }
    if (servers === undefined) throw new Error(`Главные серверы для ${name} не найдены`);

    const addresses = (
      await Promise.all(
        servers.map((server) =>
          lookup(server, { family: 4 })
            .then((found) => found.address)
            .catch(() => undefined),
        ),
      )
    ).filter((address): address is string => address !== undefined);
    if (addresses.length === 0) throw new Error('Адреса главных серверов не найдены');

    const zone = new Resolver({ timeout: TIMEOUT_MS, tries: TRIES });
    zone.setServers(addresses);
    const [v4, v6] = await Promise.allSettled([zone.resolve4(name), zone.resolve6(name)]);
    const found = [...settled(v4), ...settled(v6)];
    if (found.length > 0) return found;
    const failure = [v4, v6].find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' && !ABSENT.has(codeOf(result.reason)),
    );
    if (failure !== undefined) throw failure.reason;
    return undefined;
  }

  /**
   * Ответ DNS сервера площадки — со сроком памяти, если он его сообщает. Свой клиент c-ares на машине
   * с локальным кешем DNS или VPN отказывает там, где имя находится (2026-11-11), — тогда системный
   * `getaddrinfo`, без срока.
   */
  private async fromServer(
    name: string,
  ): Promise<{ addresses: readonly string[] | undefined; ttl: number | null }> {
    const system = new Resolver({ timeout: TIMEOUT_MS, tries: TRIES });
    try {
      const records = await system.resolve4(name, { ttl: true });
      return {
        addresses: records.map((record) => record.address),
        ttl: Math.min(...records.map((record) => record.ttl)),
      };
    } catch (cause) {
      if (ABSENT.has(codeOf(cause))) return { addresses: undefined, ttl: null };
    }
    try {
      const found = await lookup(name, { all: true, verbatim: true });
      const addresses = [...new Set(found.map((entry) => entry.address))];
      return { addresses: addresses.length === 0 ? undefined : addresses, ttl: null };
    } catch (cause) {
      if (ABSENT.has(codeOf(cause))) return { addresses: undefined, ttl: null };
      throw cause;
    }
  }
}

/** Ответ из памяти: срок старого кэша уменьшился на прошедшее время. */
function aged(answer: NameAnswer, elapsedMs: number): NameAnswer {
  if (answer.stale === null || answer.stale.expiresInSeconds === null) return answer;
  const left = answer.stale.expiresInSeconds - Math.floor(elapsedMs / 1000);
  return { ...answer, stale: left > 0 ? { ...answer.stale, expiresInSeconds: left } : null };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function settled(result: PromiseSettledResult<string[]>): string[] {
  return result.status === 'fulfilled' ? result.value : [];
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`DNS не ответил за ${String(ms)} мс`));
    }, ms);
  });
  return Promise.race([work, expired]).finally(() => {
    clearTimeout(timer);
  });
}

function codeOf(reason: unknown): string {
  return typeof reason === 'object' && reason !== null && 'code' in reason
    ? String(reason.code)
    : '';
}
