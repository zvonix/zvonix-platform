import {
  spreadHourlyLimit,
  WARMUP_DAYS,
  WARMUP_DEFAULT_CEILING,
  warmupDailyLimit,
} from '@zvonix/shared';
import type { MessengerAccountRow } from './messaging.repository.js';

/** Что аккаунту разрешено сейчас сверх лимита в минуту ([ADR-0078](../../../../../docs/adr/0078-progrev-akkauntov-max.md)). */
export interface EffectiveLimits {
  /** За скользящие сутки; пусто — без ограничения. */
  readonly daily: number | null;
  /** За скользящий час (равномерность); пусто — без ограничения. */
  readonly hourly: number | null;
  /** Номер суток прогрева с нуля; пусто — прогрева нет (выключен или закончился). */
  readonly warmupDay: number | null;
}

/**
 * Лимиты аккаунта. Автопрогрев выключен — ровно то, что задал тариф. Включён: потолок — лимит в сутки из тарифа
 * (нет его — {@link WARMUP_DEFAULT_CEILING}), пока идёт прогрев — меньшая сегодняшняя доля, плюс часовая доля суток,
 * чтобы сообщения не уходили пачкой.
 */
export function effectiveLimits(
  account: Pick<MessengerAccountRow, 'warmupEnabled' | 'warmupStartedAt' | 'limitPerDay'>,
  now: Date,
): EffectiveLimits {
  if (!account.warmupEnabled) {
    return { daily: account.limitPerDay, hourly: null, warmupDay: null };
  }
  const ceiling = account.limitPerDay ?? WARMUP_DEFAULT_CEILING;
  const day =
    account.warmupStartedAt === null
      ? null
      : Math.max(0, Math.floor((now.getTime() - account.warmupStartedAt.getTime()) / 86_400_000));
  const daily = day === null ? ceiling : warmupDailyLimit(day, ceiling);
  return {
    daily,
    hourly: spreadHourlyLimit(daily),
    warmupDay: day !== null && day < WARMUP_DAYS ? day : null,
  };
}
