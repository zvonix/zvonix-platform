/**
 * Разрешение имени адреса SIP (ADR-0113, ревизия).
 *
 * Системным разрешением (`getaddrinfo`), а не своим клиентом DNS: так имя видит всё остальное на сервере,
 * со всеми его настройками. Свой клиент c-ares спрашивает серверы из настроек сам и на машине с локальным
 * кешем DNS или VPN отвечает «отказано в соединении» там, где имя прекрасно находится (2026-11-11).
 *
 * Срок — три секунды: окно настроек ждёт ответа, и зависший DNS не должен держать его дольше. Ответ
 * запоминается на минуту — список узлов спрашивает про каждое имя, а запись у регистратора меняется
 * не чаще. «Проверить снова» минует память.
 */

import { lookup } from 'node:dns/promises';
import { Injectable } from '@nestjs/common';

/** Сколько помнить ответ. */
const CACHE_MS = 60_000;
/** Сколько ждать ответа. */
const TIMEOUT_MS = 3000;

/** Ответы, которые значат «такого имени нет», а не «DNS не ответил». */
const ABSENT = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA']);

@Injectable()
export class NameResolver {
  private readonly cache = new Map<
    string,
    { at: number; addresses: readonly string[] | undefined }
  >();

  /** Адреса имени (IPv4 и IPv6); `undefined` — имени нет. Не ответил вовремя — исключение. */
  async resolve(name: string, fresh = false): Promise<readonly string[] | undefined> {
    const key = name.toLowerCase();
    const cached = this.cache.get(key);
    if (!fresh && cached !== undefined && Date.now() - cached.at < CACHE_MS)
      return cached.addresses;

    let addresses: readonly string[] | undefined;
    try {
      const found = await withTimeout(lookup(key, { all: true, verbatim: true }), TIMEOUT_MS);
      addresses = [...new Set(found.map((entry) => entry.address))];
      if (addresses.length === 0) addresses = undefined;
    } catch (cause) {
      if (!ABSENT.has(codeOf(cause))) throw cause;
      addresses = undefined;
    }
    this.cache.set(key, { at: Date.now(), addresses });
    return addresses;
  }
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
