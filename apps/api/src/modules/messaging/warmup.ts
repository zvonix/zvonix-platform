import {
  spreadHourlyLimit,
  WARMUP_DAYS,
  WARMUP_DEFAULT_CEILING,
  warmupDailyLimit,
} from '@zvonix/shared';
import type { AccountLoad } from './messages.repository.js';
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

/** Через сколько повторять, если аккаунт упёрся в предел: минуту — коротко, час — реже, сутки — ещё реже. */
const RETRY_MS = { minute: 10_000, hour: 120_000, day: 300_000 } as const;

/**
 * Когда аккаунт сможет отправить следующее сообщение; `undefined` — может сейчас. Проверяются по порядку: пауза
 * здоровья, пауза между сообщениями, лимит в минуту (тариф), в час и в сутки (прогрев, ADR-0078).
 * `backlog` — сколько сообщений уже стоит за аккаунтом: при приёме они считаются отправленными (запас под новое),
 * при отправке — нет, ведь ждущее сообщение само одно из них.
 */
export function accountReadyAt(
  account: Pick<
    MessengerAccountRow,
    | 'warmupEnabled'
    | 'warmupStartedAt'
    | 'limitPerDay'
    | 'limitPerMinute'
    | 'lastUsedAt'
    | 'pausedUntil'
  >,
  load: AccountLoad,
  now: Date,
  options: { paceSeconds: number; withBacklog: boolean; reservePercent?: number },
): Date | undefined {
  const at = now.getTime();
  if (account.pausedUntil !== null && account.pausedUntil.getTime() > at)
    return account.pausedUntil;
  if (options.paceSeconds > 0 && account.lastUsedAt !== null) {
    const ready = account.lastUsedAt.getTime() + options.paceSeconds * 1000;
    if (ready > at) return new Date(ready);
  }
  const queue = options.withBacklog ? load.backlog : 0;
  // Запас партнёра (ADR-0080): последняя доля лимита не расходуется, но один звонок/сообщение в окне всегда доступен.
  const keep = (limit: number): number =>
    Math.max(1, Math.floor((limit * (100 - (options.reservePercent ?? 0))) / 100));
  if (account.limitPerMinute !== null && load.minute + queue >= keep(account.limitPerMinute)) {
    return new Date(at + RETRY_MS.minute);
  }
  const limits = effectiveLimits(account, now);
  if (limits.hourly !== null && load.hour + queue >= keep(limits.hourly)) {
    return new Date(at + RETRY_MS.hour);
  }
  if (limits.daily !== null && load.day + queue >= keep(limits.daily)) {
    return new Date(at + RETRY_MS.day);
  }
  return undefined;
}
