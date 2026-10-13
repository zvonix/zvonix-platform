/**
 * Состояние сертификата кабинета: чтение `certificate.json`, который пишет служба обновления
 * ([ADR-0083](../../../../../docs/adr/0083-sertifikat-v-nastroykah.md)).
 *
 * Отдельно от `CertificateService`: состояние нужно и тревогам администраторам в воркере
 * (ADR-0062), а там нет ни контроллеров, ни очереди заявок.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';

type CertificateState =
  'ok' | 'soon' | 'expired' | 'incomplete' | 'missing' | 'not_configured' | 'unknown';

export interface CertificateStatus {
  /** Служба обновления прочитала сертификат: до этого показывать нечего. */
  readonly available: boolean;
  readonly state: CertificateState;
  readonly checked_at: string | null;
  /** Имя, под которым выпускается сертификат (адрес кабинета). */
  readonly domain: string | null;
  readonly expected_names: readonly string[];
  readonly covered_names: readonly string[];
  readonly missing_names: readonly string[];
  readonly issuer: string | null;
  readonly not_before: string | null;
  readonly not_after: string | null;
  readonly days_left: number | null;
  /** Таймер продления включён; `null` — узнать не удалось. */
  readonly auto_renew: boolean | null;
  readonly problem: string | null;
}

/** Меньше стольких суток — сертификат «скоро истекает»: продление обычно идёт за тридцать. */
const SOON_DAYS = 14;
const DAY_MS = 86_400_000;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const flagOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const UNKNOWN: CertificateStatus = {
  available: false,
  state: 'unknown',
  checked_at: null,
  domain: null,
  expected_names: [],
  covered_names: [],
  missing_names: [],
  issuer: null,
  not_before: null,
  not_after: null,
  days_left: null,
  auto_renew: null,
  problem: null,
};

@Injectable()
export class CertificateStatusService {
  constructor(@Inject(APP_CONFIG) private readonly config: Config) {}

  private async readState(): Promise<Record<string, unknown> | null> {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(this.config.UPDATER_DIR, 'certificate.json'), 'utf8'),
      ) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch (error) {
      // Нет файла или он повреждён — «ещё не прочитано», а не отказ раздела.
      if (
        (error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
        error instanceof SyntaxError
      ) {
        return null;
      }
      throw error;
    }
  }

  async status(now: Date = new Date()): Promise<CertificateStatus> {
    const raw = await this.readState();
    if (raw === null) return UNKNOWN;

    const expected = strings(raw['expected_names']);
    const covered = strings(raw['covered_names']);
    const missing = expected.filter((name) => !covered.includes(name));
    const notAfter = textOrNull(raw['not_after']);
    const daysLeft =
      notAfter === null || !Number.isFinite(Date.parse(notAfter))
        ? null
        : Math.floor((Date.parse(notAfter) - now.getTime()) / DAY_MS);
    const domain = textOrNull(raw['cert_name']);
    const present = raw['present'] === true;

    let state: CertificateState;
    if (domain === null) state = 'not_configured';
    else if (!present) state = 'missing';
    else if (daysLeft !== null && daysLeft < 0) state = 'expired';
    else if (missing.length > 0) state = 'incomplete';
    else if (daysLeft !== null && daysLeft <= SOON_DAYS) state = 'soon';
    else state = 'ok';

    return {
      available: true,
      state,
      checked_at: textOrNull(raw['checked_at']),
      domain,
      expected_names: expected,
      covered_names: covered,
      missing_names: missing,
      issuer: textOrNull(raw['issuer']),
      not_before: textOrNull(raw['not_before']),
      not_after: notAfter,
      days_left: daysLeft,
      auto_renew: flagOrNull(raw['auto_renew']),
      problem: textOrNull(raw['problem']),
    };
  }
}
