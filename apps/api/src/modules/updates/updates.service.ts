/**
 * Обновление площадки из кабинета ([ADR-0074](../../../../../docs/adr/0074-obnovlenie-iz-adminki.md)).
 *
 * API ничего не запускает: он кладёт файл-заявку в каталог обмена, а выкладку выполняет отдельная
 * служба от root (`deploy/updater.py`). Состояние и журнал выкладки — файлы этой службы, API их только
 * читает. Каталога обмена нет (разработка, тесты, площадка до первой выкладки с этой возможностью) —
 * раздел отвечает «не настроено», а не придумывает пустое состояние.
 */

import { randomUUID } from 'node:crypto';
import { open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { conflict, notFound, validationFailed, type Id, type UserRole } from '@zvonix/shared';
import { readRelease, type ReleaseInfo } from '../../infra/release.js';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';

export type UpdateAction = 'deploy' | 'prepare' | 'rollback' | 'refresh';
type RunStatus = 'running' | 'succeeded' | 'failed';

export interface ReleaseItem {
  readonly tag: string;
  readonly name: string;
  readonly published_at: string | null;
  readonly prerelease: boolean;
  readonly notes: string;
}

export interface QueuedRequest {
  readonly id: string;
  readonly action: UpdateAction;
  readonly tag: string | null;
  readonly by: string;
  readonly requested_at: string;
}

export interface RunView {
  readonly id: string;
  readonly action: UpdateAction;
  readonly tag: string | null;
  readonly by: string;
  readonly requested_at: string;
  readonly status: RunStatus;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly exit_code: number | null;
}

/** Результат проверки выпуска перед установкой (`zvonix-deploy --prepare`): что и как проверено. */
export interface PreparedRelease {
  readonly tag: string;
  /** Все проверки без отказа: выпуск можно ставить. */
  readonly ok: boolean;
  /** Проверка ещё свежа: позже деплой всё равно перепроверит и не использует подготовленное. */
  readonly fresh: boolean;
  readonly checked_at: string;
  readonly checks: readonly { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }[];
}

export interface UpdatesOverview {
  readonly available: boolean;
  readonly current: ReleaseInfo;
  readonly releases_fetched_at: string | null;
  readonly releases: readonly ReleaseItem[];
  readonly prepared: readonly PreparedRelease[];
  readonly queue: readonly QueuedRequest[];
  readonly runs: readonly RunView[];
}

export interface LogChunk {
  readonly text: string;
  readonly next_offset: number;
  readonly run: RunView;
}

interface Actor {
  readonly userId: Id<'user'>;
  readonly role: UserRole;
  readonly email: string;
}

/** Не больше столько байт журнала за один ответ: кабинет догоняет остальное следующим опросом. */
const LOG_CHUNK = 64 * 1024;
const RUNS_SHOWN = 15;
/** Как долго подготовленный выпуск считается годным; то же число — `PREPARED_MAX_AGE` в `deploy/deploy.sh`. */
const PREPARED_FRESH_MS = 6 * 60 * 60 * 1000;
const REQUEST_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/u;

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function validId(id: string): boolean {
  return REQUEST_FILE.test(`${id}.json`);
}

type Json = Record<string, unknown>;

async function readJson(file: string): Promise<Json | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Json) : null;
  } catch (error) {
    // Нет файла или он повреждён: для кабинета это «нет данных», а не отказ всего раздела.
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

@Injectable()
export class UpdatesService {
  private readonly current: ReleaseInfo = readRelease();

  constructor(
    @Inject(APP_CONFIG) private readonly config: Config,
    private readonly audit: AuditService,
  ) {}

  private get requestsDir(): string {
    return path.join(this.config.UPDATER_DIR, 'requests');
  }

  private async isAvailable(): Promise<boolean> {
    try {
      return (await stat(this.requestsDir)).isDirectory();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async overview(): Promise<UpdatesOverview> {
    if (!(await this.isAvailable())) {
      return {
        available: false,
        current: this.current,
        releases_fetched_at: null,
        releases: [],
        prepared: [],
        queue: [],
        runs: [],
      };
    }
    const list = await this.releases();
    return {
      available: true,
      current: this.current,
      releases_fetched_at: list.fetchedAt,
      releases: list.items,
      prepared: await this.prepared(),
      queue: await this.queue(),
      runs: await this.runs(),
    };
  }

  private async releases(): Promise<{ fetchedAt: string | null; items: ReleaseItem[] }> {
    const raw = await readJson(path.join(this.config.UPDATER_DIR, 'releases.json'));
    if (raw === null || !Array.isArray(raw['releases'])) return { fetchedAt: null, items: [] };
    const items = (raw['releases'] as Json[]).flatMap((item) =>
      typeof item['tag'] === 'string'
        ? [
            {
              tag: item['tag'],
              name: text(item['name']) || item['tag'],
              published_at: textOrNull(item['published_at']),
              prerelease: item['prerelease'] === true,
              notes: text(item['notes']),
            },
          ]
        : [],
    );
    return { fetchedAt: textOrNull(raw['fetched_at']), items };
  }

  private async prepared(): Promise<PreparedRelease[]> {
    let names: string[];
    try {
      names = await readdir(path.join(this.config.UPDATER_DIR, 'prepared'));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const found: PreparedRelease[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const raw = await readJson(path.join(this.config.UPDATER_DIR, 'prepared', name));
      if (raw === null || typeof raw['tag'] !== 'string' || !Array.isArray(raw['checks'])) continue;
      const checkedAt = textOrNull(raw['checked_at']) ?? '';
      const age = Date.now() - Date.parse(checkedAt);
      found.push({
        tag: raw['tag'],
        ok: raw['ok'] === true,
        fresh: Number.isFinite(age) && age < PREPARED_FRESH_MS,
        checked_at: checkedAt,
        checks: (raw['checks'] as Json[]).flatMap((check) =>
          typeof check['name'] === 'string' &&
          (check['status'] === 'ok' || check['status'] === 'warn' || check['status'] === 'fail')
            ? [{ name: check['name'], status: check['status'], detail: text(check['detail']) }]
            : [],
        ),
      });
    }
    return found.sort((a, b) => b.checked_at.localeCompare(a.checked_at));
  }

  private async queue(): Promise<QueuedRequest[]> {
    const found: QueuedRequest[] = [];
    for (const name of await readdir(this.requestsDir)) {
      const id = REQUEST_FILE.exec(name)?.[1];
      if (id === undefined) continue;
      const raw = await readJson(path.join(this.requestsDir, name));
      if (raw === null) continue;
      found.push({
        id,
        action: raw['action'] as UpdateAction,
        tag: textOrNull(raw['tag']),
        by: text(raw['by']),
        requested_at: text(raw['at']),
      });
    }
    return found.sort((a, b) => a.requested_at.localeCompare(b.requested_at));
  }

  private async runs(): Promise<RunView[]> {
    let names: string[];
    try {
      names = await readdir(path.join(this.config.UPDATER_DIR, 'runs'));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const views: RunView[] = [];
    for (const name of names) {
      const run = await this.readRun(name);
      if (run !== null) views.push(run);
    }
    return views.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, RUNS_SHOWN);
  }

  private async readRun(id: string): Promise<RunView | null> {
    if (!validId(id)) return null;
    const raw = await readJson(path.join(this.config.UPDATER_DIR, 'runs', id, 'state.json'));
    if (raw === null || typeof raw['started_at'] !== 'string') return null;
    return {
      id,
      action: raw['action'] as UpdateAction,
      tag: textOrNull(raw['tag']),
      by: text(raw['by']),
      requested_at: text(raw['requested_at']),
      status: raw['status'] as RunStatus,
      started_at: raw['started_at'],
      finished_at: textOrNull(raw['finished_at']),
      exit_code: typeof raw['exit_code'] === 'number' ? raw['exit_code'] : null,
    };
  }

  /**
   * Ставит заявку в очередь. Выкладка и откат — по одной: пока есть ждущая или идущая, новая — `409`.
   * Метка берётся только из списка выпусков: произвольную строку служба не получит.
   */
  async request(actor: Actor, action: UpdateAction, tag: string | null): Promise<QueuedRequest> {
    if (!(await this.isAvailable())) {
      throw conflict('Обновление из кабинета на этой площадке не настроено');
    }
    if (action !== 'refresh') {
      const busy =
        (await this.queue()).some((item) => item.action !== 'refresh') ||
        (await this.runs()).some((run) => run.status === 'running' && run.action !== 'refresh');
      if (busy) throw conflict('Уже идёт или ждёт другое обновление — дождитесь его окончания');
    }
    if (action === 'deploy' || action === 'prepare') {
      if (tag === null) throw validationFailed('Не указан выпуск');
      const known = (await this.releases()).items.some((item) => item.tag === tag);
      if (!known) throw notFound('Такого выпуска нет в списке — нажмите «Проверить обновления»');
      if (tag === this.current.version) throw conflict('Этот выпуск уже работает');
    }

    const id = randomUUID();
    const request: QueuedRequest = {
      id,
      action,
      tag: action === 'deploy' || action === 'prepare' ? tag : null,
      by: actor.email,
      requested_at: new Date().toISOString(),
    };
    // Временное имя не совпадает с шаблоном заявки: служба не увидит недописанный файл.
    const final = path.join(this.requestsDir, `${id}.json`);
    await writeFile(
      `${final}.tmp`,
      JSON.stringify({ action, tag: request.tag, by: request.by, at: request.requested_at }),
      { flag: 'wx', mode: 0o640 },
    );
    await rename(`${final}.tmp`, final);

    await this.audit.record({
      action: `update.${action}_requested`,
      entityType: 'update',
      entityId: id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      after: { action, tag: request.tag },
    });
    return request;
  }

  /** Отмена заявки, которую служба ещё не приняла. Принятую выкладку не остановить — ADR-0074. */
  async cancel(actor: Actor, id: string): Promise<void> {
    if (!validId(id)) throw validationFailed('Идентификатор записан неверно');
    try {
      await unlink(path.join(this.requestsDir, `${id}.json`));
    } catch (error) {
      if (isMissing(error)) {
        throw conflict('Заявка уже принята в работу или не существует — отменить её нельзя');
      }
      throw error;
    }
    await this.audit.record({
      action: 'update.cancelled',
      entityType: 'update',
      entityId: id,
      actorUserId: actor.userId,
      actorRole: actor.role,
    });
  }

  /** Журнал выкладки с указанного смещения. Незавершённую строку держим до перевода строки. */
  async log(id: string, offset: number): Promise<LogChunk> {
    if (!validId(id)) throw validationFailed('Идентификатор записан неверно');
    const run = await this.readRun(id);
    if (run === null) throw notFound('Такого обновления нет');

    let handle;
    try {
      handle = await open(path.join(this.config.UPDATER_DIR, 'runs', id, 'log'), 'r');
    } catch (error) {
      if (isMissing(error)) return { text: '', next_offset: offset, run };
      throw error;
    }
    try {
      const buffer = Buffer.alloc(LOG_CHUNK);
      const { bytesRead } = await handle.read(buffer, 0, LOG_CHUNK, offset);
      let end = bytesRead;
      const running = run.status === 'running';
      if (running || bytesRead === LOG_CHUNK) {
        // Не режем строку и многобайтовый знак посередине: отдаём до последнего перевода строки.
        // Журнал дописывается, пока выкладка идёт, — недописанная строка подождёт следующего опроса.
        const lastBreak = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (lastBreak !== -1) end = lastBreak + 1;
        else if (running) end = 0;
      }
      return { text: buffer.subarray(0, end).toString('utf8'), next_offset: offset + end, run };
    } finally {
      await handle.close();
    }
  }
}
