/**
 * Состояние токена GitHub, которым служба обновления скачивает выпуски: чтение `github-token.json`
 * ([ADR-0084](../../../../../docs/adr/0084-token-github-v-nastroykah.md)).
 *
 * Сам токен API не знает и не читает: служба пишет только дату окончания и исход проверки.
 * Отдельно от `GithubTokenService`: состояние нужно и тревогам администраторам в воркере (ADR-0062).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';

type GithubTokenState = 'ok' | 'soon' | 'invalid' | 'unknown';

export interface GithubTokenStatus {
  /** Служба хотя бы раз проверила токен: до этого показывать нечего. */
  readonly available: boolean;
  readonly state: GithubTokenState;
  readonly repository: string | null;
  readonly checked_at: string | null;
  /** `null` — срока нет (классический токен) или он не известен. */
  readonly expires_at: string | null;
  readonly days_left: number | null;
  readonly problem: string | null;
}

/** Меньше стольких суток — токен «скоро кончится»: пора выпустить новый. */
const SOON_DAYS = 14;
const DAY_MS = 86_400_000;

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

@Injectable()
export class GithubTokenStatusService {
  constructor(@Inject(APP_CONFIG) private readonly config: Config) {}

  async status(now: Date = new Date()): Promise<GithubTokenStatus> {
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(
        await readFile(path.join(this.config.UPDATER_DIR, 'github-token.json'), 'utf8'),
      ) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return unknown();
      raw = parsed as Record<string, unknown>;
    } catch (error) {
      // Нет файла или он повреждён — «ещё не проверено», а не отказ раздела.
      if (
        (error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
        error instanceof SyntaxError
      ) {
        return unknown();
      }
      throw error;
    }

    const expires = textOrNull(raw['expires_at']);
    const daysLeft =
      expires === null || !Number.isFinite(Date.parse(expires))
        ? null
        : Math.floor((Date.parse(expires) - now.getTime()) / DAY_MS);
    let state: GithubTokenState;
    if (raw['valid'] !== true || (daysLeft !== null && daysLeft < 0)) state = 'invalid';
    else if (daysLeft !== null && daysLeft <= SOON_DAYS) state = 'soon';
    else state = 'ok';

    return {
      available: true,
      state,
      repository: textOrNull(raw['repository']),
      checked_at: textOrNull(raw['checked_at']),
      expires_at: expires,
      days_left: daysLeft,
      problem: textOrNull(raw['problem']),
    };
  }
}

function unknown(): GithubTokenStatus {
  return {
    available: false,
    state: 'unknown',
    repository: null,
    checked_at: null,
    expires_at: null,
    days_left: null,
    problem: null,
  };
}
