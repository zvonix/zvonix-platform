/**
 * Последний исход обращения к провайдеру сообщений, общий для API и воркера через Redis
 * ([ADR-0062](../../../../../docs/adr/0062-trevogi-administratoram.md), ревизия 2026-10-18).
 *
 * Нужен тревоге «провайдер не отвечает»: вход по QR и отправка идут в разных процессах, и без общего места
 * сбой одного не виден другому. Записывается только то, что похоже на поломку у провайдера или сети (таймаут,
 * обрыв, ответ 5xx); отказ по существу (неверный ключ, нет такого аккаунта) — не поломка.
 */

import { isRedisReady, type RedisService } from '../../infra/redis.js';

export const PROVIDER_OUTAGE_KEY = 'zvonix:messenger:provider-outage';

/** Запись живёт сутки: без новых обращений давний сбой ничего не говорит о нынешнем состоянии. */
const TTL_SECONDS = 86_400;

export type OutageReason = 'timeout' | 'network' | 'server';

export interface ProviderOutage {
  readonly at: Date;
  readonly reason: OutageReason;
  readonly status?: number;
}

/** Сбой провайдера. Запись «по возможности»: недоступный Redis не должен ломать само обращение. */
export async function recordProviderOutage(
  redis: RedisService | undefined,
  outage: { reason: OutageReason; status?: number },
  now: Date = new Date(),
): Promise<void> {
  if (redis === undefined || !isRedisReady(redis.connection)) return;
  try {
    await redis.connection.set(
      PROVIDER_OUTAGE_KEY,
      JSON.stringify({ at: now.toISOString(), ...outage }),
      'EX',
      TTL_SECONDS,
    );
  } catch {
    // Тревога — вспомогательная функция: потеря одной записи не стоит сорванного обращения.
  }
}

/** Провайдер ответил как положено — прежний сбой снят. */
export async function clearProviderOutage(redis: RedisService | undefined): Promise<void> {
  if (redis === undefined || !isRedisReady(redis.connection)) return;
  try {
    await redis.connection.del(PROVIDER_OUTAGE_KEY);
  } catch {
    // См. выше.
  }
}

/** Незакрытый сбой провайдера, если он есть. */
export async function readProviderOutage(redis: RedisService): Promise<ProviderOutage | undefined> {
  const raw = await redis.connection.get(PROVIDER_OUTAGE_KEY);
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { at?: unknown; reason?: unknown; status?: unknown };
    const at = typeof parsed.at === 'string' ? new Date(parsed.at) : undefined;
    if (at === undefined || Number.isNaN(at.getTime())) return undefined;
    const reason: OutageReason =
      parsed.reason === 'timeout' || parsed.reason === 'server' ? parsed.reason : 'network';
    return {
      at,
      reason,
      ...(typeof parsed.status === 'number' ? { status: parsed.status } : {}),
    };
  } catch {
    return undefined;
  }
}
