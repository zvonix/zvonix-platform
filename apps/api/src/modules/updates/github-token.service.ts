/**
 * Токен GitHub в настройках ([ADR-0084](../../../../../docs/adr/0084-token-github-v-nastroykah.md)).
 *
 * API токен не хранит и назад не отдаёт: он уходит службе обновления одной заявкой, служба проверяет его
 * у GitHub и только тогда записывает в файл root. Репозиторий заявкой не задаётся.
 */

import { Injectable } from '@nestjs/common';
import { conflict, type Id, type UserRole } from '@zvonix/shared';
import { GithubTokenStatusService, type GithubTokenStatus } from './github-token-status.service.js';
import { UpdatesService, type QueuedRequest, type RunView } from './updates.service.js';

export interface GithubTokenView extends GithubTokenStatus {
  /** Заявка с токеном ждёт или проверяется: ввод в это время закрыт. */
  readonly busy: boolean;
  readonly last_run: {
    readonly id: string;
    readonly status: RunView['status'];
    readonly finished_at: string | null;
  } | null;
}

interface Actor {
  readonly userId: Id<'user'>;
  readonly role: UserRole;
  readonly email: string;
}

@Injectable()
export class GithubTokenService {
  constructor(
    private readonly status: GithubTokenStatusService,
    private readonly updates: UpdatesService,
  ) {}

  async view(now: Date = new Date()): Promise<GithubTokenView> {
    const [status, queue, runs] = await Promise.all([
      this.status.status(now),
      this.updates.queued(),
      this.updates.recentRuns(),
    ]);
    const tokenRuns = runs.filter((run) => run.action === 'token-set');
    const busy =
      queue.some((item) => item.action === 'token-set') ||
      tokenRuns.some((run) => run.status === 'running');
    const last = tokenRuns[0];
    return {
      ...status,
      busy,
      last_run:
        last === undefined
          ? null
          : { id: last.id, status: last.status, finished_at: last.finished_at },
    };
  }

  async set(actor: Actor, token: string): Promise<QueuedRequest> {
    if ((await this.view()).busy) {
      throw conflict('Предыдущий токен ещё проверяется — дождитесь результата');
    }
    return this.updates.request(actor, 'token-set', null, { token });
  }
}
