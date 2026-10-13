/**
 * Сертификат кабинета в настройках ([ADR-0083](../../../../../docs/adr/0083-sertifikat-v-nastroykah.md)).
 *
 * Как у обновления (ADR-0074): API ничего не выпускает и системой не управляет. Состояние читается из
 * `certificate.json`, который пишет служба обновления от root, а действия — выпуск, проверка, автопродление —
 * ставятся ей заявками. Имя сертификата в заявке не передаётся: служба берёт его из своих файлов, поэтому
 * выпустить сертификат на чужое имя через API нельзя.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { conflict, type Id, type UserRole } from '@zvonix/shared';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';
import { UpdatesService, type QueuedRequest, type RunView } from './updates.service.js';

type CertificateState =
  'ok' | 'soon' | 'expired' | 'incomplete' | 'missing' | 'not_configured' | 'unknown';

export interface CertificateView {
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
  /** Заявка на сертификат ждёт или выполняется: кнопки в это время закрыты. */
  readonly busy: boolean;
  readonly last_run: {
    readonly id: string;
    readonly action: string;
    readonly status: RunView['status'];
    readonly finished_at: string | null;
    readonly exit_code: number | null;
  } | null;
}

interface Actor {
  readonly userId: Id<'user'>;
  readonly role: UserRole;
  readonly email: string;
}

/** Меньше стольких суток — сертификат «скоро истекает»: продление обычно идёт за тридцать. */
const SOON_DAYS = 14;
/** Let's Encrypt ограничивает выпуск тех же имён (пять в неделю) и ошибки (пять в час). */
const ISSUE_COOLDOWN_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const flagOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

@Injectable()
export class CertificateService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: Config,
    private readonly updates: UpdatesService,
  ) {}

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

  async view(now: Date = new Date()): Promise<CertificateView> {
    const raw = await this.readState();
    const [queue, runs] = await Promise.all([this.updates.queued(), this.updates.recentRuns()]);
    const certRuns = runs.filter((run) => run.action.startsWith('cert-'));
    const busy =
      queue.some((item) => item.action.startsWith('cert-')) ||
      certRuns.some((run) => run.status === 'running');
    const last = certRuns.find((run) => run.action !== 'cert-check') ?? certRuns[0];
    const lastRun =
      last === undefined
        ? null
        : {
            id: last.id,
            action: last.action,
            status: last.status,
            finished_at: last.finished_at,
            exit_code: last.exit_code,
          };

    if (raw === null) {
      return {
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
        busy,
        last_run: lastRun,
      };
    }

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
      busy,
      last_run: lastRun,
    };
  }

  /** Перечитать сертификат сейчас, не дожидаясь таймера. Лёгкое действие: не мешает обновлению. */
  async check(actor: Actor): Promise<QueuedRequest> {
    return this.updates.request(actor, 'cert-check', null);
  }

  /** Выпустить или перевыпустить сертификат. Часто нельзя: у Let's Encrypt свои пределы. */
  async issue(actor: Actor): Promise<QueuedRequest> {
    const view = await this.view();
    if (view.state === 'not_configured') {
      throw conflict('Кабинет открыт не по домену: сертификат выпускается только на домен');
    }
    const recent = (await this.updates.recentRuns()).some(
      (run) =>
        run.action === 'cert-issue' && Date.now() - Date.parse(run.started_at) < ISSUE_COOLDOWN_MS,
    );
    if (recent) {
      throw conflict(
        'Выпуск уже запускали меньше десяти минут назад: у Let’s Encrypt есть пределы на повторы',
      );
    }
    return this.updates.request(actor, 'cert-issue', null);
  }

  async setAuto(actor: Actor, enabled: boolean): Promise<QueuedRequest> {
    return this.updates.request(actor, enabled ? 'cert-auto-on' : 'cert-auto-off', null);
  }
}
