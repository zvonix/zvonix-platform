/**
 * Сертификат кабинета в настройках ([ADR-0083](../../../../../docs/adr/0083-sertifikat-v-nastroykah.md)).
 *
 * Как у обновления (ADR-0074): API ничего не выпускает и системой не управляет. Состояние читается из
 * `certificate.json`, который пишет служба обновления от root, а действия — выпуск, проверка, автопродление —
 * ставятся ей заявками. Имя сертификата в заявке не передаётся: служба берёт его из своих файлов, поэтому
 * выпустить сертификат на чужое имя через API нельзя.
 */

import { Injectable } from '@nestjs/common';
import { conflict, type Id, type UserRole } from '@zvonix/shared';
import { CertificateStatusService, type CertificateStatus } from './certificate-status.service.js';
import { UpdatesService, type QueuedRequest, type RunView } from './updates.service.js';

export interface CertificateView extends CertificateStatus {
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

/** Let's Encrypt ограничивает выпуск тех же имён (пять в неделю) и ошибки (пять в час). */
const ISSUE_COOLDOWN_MS = 10 * 60_000;

@Injectable()
export class CertificateService {
  constructor(
    private readonly certificateStatus: CertificateStatusService,
    private readonly updates: UpdatesService,
  ) {}

  async view(now: Date = new Date()): Promise<CertificateView> {
    const [status, queue, runs] = await Promise.all([
      this.certificateStatus.status(now),
      this.updates.queued(),
      this.updates.recentRuns(),
    ]);
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
    return { ...status, busy, last_run: lastRun };
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
