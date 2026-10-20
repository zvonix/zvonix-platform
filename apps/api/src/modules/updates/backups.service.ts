/**
 * Резервные копии из кабинета ([ADR-0086](../../../../../docs/adr/0086-rezervnye-kopii-v-kabinete.md)).
 *
 * Как и обновление, API ничего не запускает: создание, проверка и выдача копии — заявки службе от root. Скачивание
 * копии — самое чувствительное, что отдаёт кабинет (в ней вся база): запись в журнал, файл выдаётся один раз и
 * удаляется. Повторного пароля и кода нет нигде: вошёл администратор — значит, пароль и второй фактор уже были
 * (владелец, 2026-10-20); восстановление защищает слово «ВОССТАНОВИТЬ» и журнал.
 */

import { constants, createWriteStream } from 'node:fs';
import { access, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  dependencyUnavailable,
  notFound,
  validationFailed,
  type Id,
  type UserRole,
} from '@zvonix/shared';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../identity/identity.service.js';
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

/** Загружаемая копия: больше этого nginx кабинета (`/api/storage/`, 200 МБ) всё равно не пропустит. */
const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
/** Начало файла `pg_dump -Fc`: по нему отличается копия от случайного файла. */
const DUMP_MAGIC = 'PGDMP';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

@Injectable()
export class BackupsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: Config,
    private readonly updates: UpdatesService,
    private readonly status: BackupStatusService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {}

  async listing(): Promise<BackupListing> {
    const listing = await this.status.listing();
    if (!listing.available) return listing;
    const running = (await this.updates.recentRuns()).filter(
      (run) => run.status === 'running' && run.target !== null && run.action.startsWith('backup-'),
    );
    return {
      ...listing,
      active: running.map((run) => ({ action: run.action, target: run.target ?? '' })),
    };
  }

  create(actor: Actor): Promise<QueuedRequest> {
    return this.updates.request(actor, 'backup-create', null);
  }

  /** Проверка во временной базе: рабочие данные не трогаются, поэтому подтверждение не нужно. */
  async verify(actor: Actor, id: string): Promise<QueuedRequest> {
    const item = await this.known(id);
    return this.updates.request(actor, 'backup-verify', null, undefined, item.id);
  }

  /** Выдача копии для скачивания: без повторного подтверждения, запись в журнал — при самом скачивании. */
  async requestExport(actor: Actor, id: string): Promise<QueuedRequest> {
    const item = await this.known(id);
    return this.updates.request(actor, 'backup-export', null, undefined, item.id);
  }

  /**
   * Загрузка скачанной копии (например, на свежеустановленный сервер): файл принимается потоком в каталог загрузки,
   * проверяется начало файла, и службе уходит заявка `backup-import` — она проверит копию целиком и положит её в список.
   * Повторного пароля нет, как и при скачивании; восстановление из загруженной копии подтверждается отдельно.
   */
  async receiveUpload(
    actor: Actor,
    body: Readable,
    declaredBytes: number | undefined,
  ): Promise<QueuedRequest> {
    if (!(await this.updates.isAvailable())) {
      throw conflict('Обновление из кабинета на этой площадке не настроено');
    }
    if (declaredBytes !== undefined && declaredBytes > UPLOAD_MAX_BYTES) {
      throw validationFailed('Файл слишком большой: загрузить можно до 200 МБ');
    }
    const directory = path.join(this.config.UPDATER_DIR, 'uploads');
    try {
      await mkdir(directory, { recursive: true, mode: 0o750 });
      await access(directory, constants.W_OK);
    } catch (error) {
      // Каталог создаёт служба обновления, а писать в него API разрешает только свежий выпуск: не «внутренняя ошибка».
      this.logger.error('Каталог загрузки копий недоступен для записи', error, { directory });
      throw dependencyUnavailable(
        'Сервер пока не принимает загрузку копий: подождите несколько минут после обновления и повторите',
      );
    }
    const id = randomUUID();
    // Временное имя не совпадает с идентификатором загрузки: недописанный файл служба не примет.
    const part = path.join(directory, `${id}.part`);
    const final = path.join(directory, `${id}.dump`);

    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > UPLOAD_MAX_BYTES) {
          done(validationFailed('Файл слишком большой: загрузить можно до 200 МБ'));
          return;
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(body, limit, createWriteStream(part, { flags: 'wx', mode: 0o600 }));
      const head = Buffer.alloc(DUMP_MAGIC.length);
      const handle = await open(part, 'r');
      try {
        await handle.read(head, 0, head.length, 0);
      } finally {
        await handle.close();
      }
      if (size === 0 || head.toString('latin1') !== DUMP_MAGIC) {
        throw validationFailed(
          'Это не файл копии Zvonix: ожидается файл, скачанный из этого раздела',
        );
      }
      await rename(part, final);
    } catch (error) {
      await this.discard(part);
      throw error;
    }

    let queued: QueuedRequest;
    try {
      queued = await this.updates.request(actor, 'backup-import', null, undefined, id);
    } catch (error) {
      await this.discard(final);
      throw error;
    }
    await this.audit.record({
      action: 'backup.uploaded',
      entityType: 'backup',
      entityId: queued.id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      after: { size },
    });
    return queued;
  }

  /**
   * Восстановление: заявка службе. Слово «ВОССТАНОВИТЬ» проверяет схема запроса; службе нужен только идентификатор копии. Что произойдёт, решает служба по ADR-0086: копия проверяется, снимается страховочная копия
   * рабочей базы, рабочая база не стирается, а откладывается.
   */
  async requestRestore(principal: Principal, id: string): Promise<QueuedRequest> {
    const item = await this.known(id);
    return this.updates.request(
      { userId: principal.userId, role: principal.role, email: principal.email },
      'backup-restore',
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
}
