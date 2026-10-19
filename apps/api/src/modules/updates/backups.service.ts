/**
 * Резервные копии из кабинета ([ADR-0086](../../../../../docs/adr/0086-rezervnye-kopii-v-kabinete.md)).
 *
 * Как и обновление, API ничего не запускает: создание, проверка и выдача копии — заявки службе от root. Скачивание
 * копии — самое чувствительное, что отдаёт кабинет (в ней вся база), поэтому перед ним — повторный пароль и код
 * второго фактора, не больше пяти неудачных попыток за 15 минут, запись в журнал; файл выдаётся один раз.
 */

import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { notFound, rateLimited, type Id, type UserRole } from '@zvonix/shared';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { IdentityService, type Principal } from '../identity/identity.service.js';
import { RateLimitService, type LimitRule } from '../limits/rate-limit.service.js';
import {
  BackupStatusService,
  type BackupItem,
  type BackupListing,
} from './backup-status.service.js';
import { UpdatesService, type QueuedRequest } from './updates.service.js';

interface Actor {
  readonly userId: Id<'user'>;
  readonly role: UserRole;
  readonly email: string;
}

/** Неудачные подтверждения: пять за пятнадцать минут, потом — ждать. */
const CONFIRM_RULE: LimitRule = { name: 'backup.confirm', limit: 5, windowSeconds: 900 };

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

@Injectable()
export class BackupsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: Config,
    private readonly updates: UpdatesService,
    private readonly status: BackupStatusService,
    private readonly identity: IdentityService,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  listing(): Promise<BackupListing> {
    return this.status.listing();
  }

  create(actor: Actor): Promise<QueuedRequest> {
    return this.updates.request(actor, 'backup-create', null);
  }

  /** Проверка во временной базе: рабочие данные не трогаются, поэтому подтверждение не нужно. */
  async verify(actor: Actor, id: string): Promise<QueuedRequest> {
    const item = await this.known(id);
    return this.updates.request(actor, 'backup-verify', null, undefined, item.id);
  }

  /** Выдача копии для скачивания: после повторного подтверждения. */
  async requestExport(
    principal: Principal,
    id: string,
    confirmation: { password: string; code?: string | undefined },
  ): Promise<QueuedRequest> {
    await this.confirm(principal, confirmation);
    const item = await this.known(id);
    return this.updates.request(
      { userId: principal.userId, role: principal.role, email: principal.email },
      'backup-export',
      null,
      undefined,
      item.id,
    );
  }

  /**
   * Файл выданной копии: только тому, кто её заказал, и только пока заявка выполнена. Удаляется сразу после
   * скачивания (вызывающий зовёт `discard`), а недокачанное служба убирает через полчаса.
   */
  async exported(
    actor: Actor,
    runId: string,
  ): Promise<{ file: string; size: number; name: string; target: string }> {
    const run = RUN_ID.test(runId) ? await this.updates.findRun(runId) : undefined;
    if (
      run === undefined ||
      run.action !== 'backup-export' ||
      run.status !== 'succeeded' ||
      run.by !== actor.email ||
      run.target === null
    ) {
      throw notFound('Копия не найдена или уже скачана');
    }
    const file = path.join(this.config.UPDATER_DIR, 'exports', `${runId}.dump`);
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw notFound('Копия не найдена или уже скачана');
      }
      throw error;
    }
    await this.audit.record({
      action: 'backup.downloaded',
      entityType: 'backup',
      entityId: runId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      after: { target: run.target, size },
    });
    return { file, size, name: run.target.replace('/', '-'), target: run.target };
  }

  /** Скачанный файл больше не нужен: в нём вся база, и лежать он не должен ни минуты дольше. */
  async discard(file: string): Promise<void> {
    try {
      await unlink(file);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }

  private async known(id: string): Promise<BackupItem> {
    const item = (await this.status.listing()).items.find((entry) => entry.id === id);
    if (item === undefined) throw notFound('Такой копии нет в списке');
    return item;
  }

  private async confirm(
    principal: Principal,
    confirmation: { password: string; code?: string | undefined },
  ): Promise<void> {
    const subject = principal.userId;
    const verdict = await this.limits.check(CONFIRM_RULE, subject);
    if (!verdict.allowed) {
      throw rateLimited('Слишком много неверных подтверждений: попробуйте через 15 минут');
    }
    try {
      await this.identity.confirmSensitive(principal, confirmation);
    } catch (error) {
      // Считаются только неудачи: верное подтверждение лимит не расходует.
      await this.limits.hit(CONFIRM_RULE, subject);
      throw error;
    }
  }
}
