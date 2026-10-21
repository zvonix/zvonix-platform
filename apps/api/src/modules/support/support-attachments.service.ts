/**
 * Картинки в обращениях ([ADR-0089](../../../../../docs/adr/0089-obrashcheniya-statusy-i-kartinki.md)).
 *
 * Файл загружается отдельным запросом (тело — сами байты), проверяется **по содержимому** и ложится на диск площадки; в базе остаётся
 * строка о нём. Отправляя сообщение, автор или сотрудник называет идентификаторы загруженных файлов — они прикрепляются. Не
 * прикреплённые за сутки стираются. Смотреть файл может автор обращения и сотрудники; заметки сотрудников и их картинки автору не видны.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  notFound,
  rateLimited,
  TICKET_IMAGE_DAILY_BYTES,
  TICKET_IMAGE_EXTENSION,
  TICKET_IMAGE_MAX_BYTES,
  TICKET_IMAGE_MIME,
  TICKET_IMAGES_PER_MESSAGE,
  imageTypeOf,
  validationFailed,
  isStaffRole,
  type Id,
} from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { SupportRepository, type AttachmentRow } from './support.repository.js';
import type { SupportActor } from './support.service.js';

const DAY_MS = 86_400_000;
/** Не прикреплённая к сообщению картинка живёт сутки: человек мог загрузить и передумать. */
const UNLINKED_KEEP_MS = DAY_MS;

/** Читает тело не больше `max` байт; больше — `undefined`, остаток запроса не читается. */
async function readLimited(stream: Readable, max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const part = chunk as Buffer;
    size += part.length;
    if (size > max) return undefined;
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

/** Имя для показа: без путей и служебных знаков, не длиннее 80. Пусто — по типу. */
function displayName(raw: string | undefined, extension: string): string {
  const base = (raw ?? '')
    .replace(/[\\/]+/gu, ' ')
    .replace(/\p{C}/gu, '')
    .trim()
    .slice(0, 80);
  return base === '' ? `картинка.${extension}` : base;
}

export interface AttachmentFile {
  readonly path: string;
  readonly contentType: string;
  readonly name: string;
  readonly size: number;
}

@Injectable()
export class SupportAttachmentsService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: SupportRepository,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('support-files');
  }

  /** Принимает одну картинку: проверка размера, типа по содержимому, суточного предела; запись на диск и строка в базе. */
  async receive(
    actor: SupportActor,
    body: Readable,
    declaredBytes: number | undefined,
    rawName: string | undefined,
    now: Date = new Date(),
  ): Promise<AttachmentRow> {
    if (declaredBytes !== undefined && declaredBytes > TICKET_IMAGE_MAX_BYTES) {
      throw validationFailed('Картинка больше 5 МБ');
    }
    const bytes = await readLimited(body, TICKET_IMAGE_MAX_BYTES);
    if (bytes === undefined) throw validationFailed('Картинка больше 5 МБ');
    const type = imageTypeOf(bytes);
    if (type === undefined) {
      throw validationFailed('Можно прикладывать только картинки PNG, JPEG и WebP');
    }
    const used = await this.repository.uploadedBytesSince(
      actor.userId,
      new Date(now.getTime() - DAY_MS),
    );
    if (used + bytes.length > TICKET_IMAGE_DAILY_BYTES) {
      throw rateLimited('Картинок за сутки загружено слишком много: повторите завтра');
    }

    const extension = TICKET_IMAGE_EXTENSION[type];
    const storedName = path.posix.join(
      now.toISOString().slice(0, 7),
      `${randomUUID()}.${extension}`,
    );
    const target = path.join(this.config.SUPPORT_DIR, storedName);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o640 });
    try {
      return await this.repository.addAttachment({
        uploaderUserId: actor.userId,
        storedName,
        originalName: displayName(rawName, extension),
        contentType: type,
        size: bytes.length,
      });
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
  }

  /**
   * Перед отправкой сообщения: названные файлы существуют, загружены этим же человеком и ещё никуда не прикреплены; их не больше
   * пяти. Возвращает уникальные идентификаторы.
   */
  async assertUsable(
    actor: SupportActor,
    ids: readonly string[],
  ): Promise<Id<'supportAttachment'>[]> {
    const unique = [...new Set(ids)] as Id<'supportAttachment'>[];
    if (unique.length > TICKET_IMAGES_PER_MESSAGE) {
      throw validationFailed(
        `Картинок не больше ${String(TICKET_IMAGES_PER_MESSAGE)} на сообщение`,
      );
    }
    if (unique.length === 0) return unique;
    const found = await this.repository.freeAttachments(actor.userId, unique);
    if (found.length !== unique.length) {
      throw conflict('Картинка не найдена или уже прикреплена: загрузите её заново');
    }
    return unique;
  }

  /** Файл для показа: автору обращения и сотрудникам; загрузивший видит свой ещё не прикреплённый. */
  async fileFor(actor: SupportActor, id: string): Promise<AttachmentFile> {
    const found = await this.repository.attachmentWithContext(id);
    if (found === undefined) throw notFound('Картинка не найдена');
    const { attachment, ticket, internal } = found;
    let allowed: boolean;
    if (ticket === undefined) allowed = attachment.uploaderUserId === actor.userId;
    else if (isStaffRole(actor.role)) allowed = true;
    else allowed = ticket.authorUserId === actor.userId && !internal;
    if (!allowed) throw notFound('Картинка не найдена');
    return {
      path: path.join(this.config.SUPPORT_DIR, attachment.storedName),
      contentType: TICKET_IMAGE_MIME[attachment.contentType],
      name: attachment.originalName,
      size: attachment.size,
    };
  }

  /** Фоновая задача: картинки, которые так и не прикрепили за сутки, стираются (строка и файл). Возвращает, сколько стёрто. */
  async purgeUnlinked(now: Date): Promise<number> {
    const stale = await this.repository.deleteUnlinkedBefore(
      new Date(now.getTime() - UNLINKED_KEEP_MS),
    );
    for (const row of stale) {
      await rm(path.join(this.config.SUPPORT_DIR, row.storedName), { force: true }).catch(
        (cause: unknown) => {
          this.logger.warn('Файл картинки не удалён с диска', {
            reason: cause instanceof Error ? cause.name : 'unknown',
          });
        },
      );
    }
    return stale.length;
  }
}
