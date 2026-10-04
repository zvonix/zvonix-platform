/**
 * Записи разговоров на диске площадки
 * ([ADR-0063](../../../../../docs/adr/0063-hranilishche-zapisey-na-diske.md)).
 *
 * Тот же интерфейс, что у S3-хранилища: остальной код не знает, где лежат файлы. Отличие
 * одно — подписанные ссылки собирает сама площадка и сама же проверяет подпись, когда по
 * ссылке приходят (`StorageFilesController`).
 *
 * Ссылка даёт доступ к одному объекту на короткий срок и больше ни к чему: подпись
 * покрывает операцию, ключ и срок, поэтому ссылку на прослушивание нельзя превратить
 * в ссылку на выгрузку и подставить чужой ключ.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { dependencyUnavailable, validationFailed } from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import type { ObjectStorage } from './object-storage.js';

export type LinkOperation = 'get' | 'put';

/** Предел одной записи: час разговора в стерео — меньше 60 МБ, так что запас четырёхкратный. */
const MAX_RECORDING_BYTES = 200 * 1024 * 1024;

/** Вид ключа, который задаёт `recordingObjectKey`. Всё остальное — не наш объект. */
const KEY_PATTERN =
  /^recordings\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/u;

/** Назначение производного ключа: подпись ссылок на записи не годится ни для чего другого. */
const KEY_PURPOSE = 'zvonix:recording-link:v1';

export interface ReadHandle {
  readonly size: number;
  open(range?: { start: number; end: number }): ReadStream;
}

@Injectable()
export class LocalObjectStorage implements ObjectStorage, OnModuleInit {
  private readonly logger: Logger;
  private readonly root: string;
  private readonly baseUrl: string;
  private readonly signingKey: Buffer;

  constructor(@Inject(APP_CONFIG) config: Config, @Inject(APP_LOGGER) logger: Logger) {
    this.logger = logger.child('recordings-storage');
    this.root = resolve(config.RECORDINGS_DIR);
    // Кабинет и API за одним адресом, API — под `/api/` (ADR-0037, deploy/nginx).
    this.baseUrl = `${config.WEB_BASE_URL.replace(/\/+$/u, '')}/api/storage/recordings`;
    this.signingKey = createHmac('sha256', config.SECRET_KEY).update(KEY_PURPOSE).digest();
  }

  /**
   * Каталог записей должен принимать запись. Проверяется при запуске, а не при первой выгрузке:
   * 2026-10-04 запись молча не шла сутки — служба не могла войти в каталог (он лежал внутри
   * каталога другого пользователя), а узел только получал `500` и копил файлы. Не получилось —
   * громкая ошибка в журнале с названием каталога; процесс при этом не падает: площадка без записей
   * важнее остановленной площадки.
   */
  async onModuleInit(): Promise<void> {
    const problem = await this.checkWritable();
    if (problem !== undefined) {
      this.logger.error(
        'Каталог записей недоступен для записи — разговоры сохраняться не будут',
        problem,
        { directory: this.root },
      );
    }
  }

  /** `undefined` — каталог принимает файлы; иначе — причина. */
  async checkWritable(): Promise<Error | undefined> {
    const probe = resolve(this.root, `.probe-${String(process.pid)}`);
    try {
      await mkdir(this.root, { recursive: true });
      await writeFile(probe, 'ok');
      await unlink(probe);
      return undefined;
    } catch (cause) {
      return cause as Error;
    }
  }

  presignUpload(objectKey: string, ttlSeconds: number): Promise<string> {
    return this.signed('put', objectKey, ttlSeconds);
  }

  presignDownload(objectKey: string, ttlSeconds: number): Promise<string> {
    return this.signed('get', objectKey, ttlSeconds);
  }

  async remove(objectKey: string): Promise<void> {
    try {
      await unlink(this.pathOf(objectKey));
    } catch (cause) {
      // Нет файла — цель достигнута: срок истёк, а хранить нечего.
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw dependencyUnavailable('Хранилище записей недоступно', { cause });
    }
  }

  /** Подпись верна и срок не вышел. Сравнение за постоянное время. */
  verify(operation: LinkOperation, objectKey: string, expires: number, signature: string): boolean {
    if (!Number.isInteger(expires) || expires * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.sign(operation, objectKey, expires), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** Читаемый файл или `undefined`, если его нет. */
  async handle(objectKey: string): Promise<ReadHandle | undefined> {
    const path = this.pathOf(objectKey);
    try {
      const info = await stat(path);
      if (!info.isFile()) return undefined;
      return {
        size: info.size,
        open: (range) => createReadStream(path, range),
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw dependencyUnavailable('Хранилище записей недоступно', { cause });
    }
  }

  /**
   * Принимает файл потоком.
   *
   * Сначала временный файл рядом, потом переименование: оборванная выгрузка не оставляет
   * на месте записи обрезок, который потом проигрывается как полный разговор. Размер
   * считается на лету — предел действует и тогда, когда заголовок длины соврал.
   */
  async write(objectKey: string, body: Readable): Promise<number> {
    const path = this.pathOf(objectKey);
    const temporary = `${path}.${String(process.pid)}.${String(Date.now())}.part`;
    await mkdir(dirname(path), { recursive: true });

    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > MAX_RECORDING_BYTES) {
          done(validationFailed('Запись больше допустимого размера'));
          return;
        }
        done(null, chunk);
      },
    });

    try {
      await pipeline(body, counter, createWriteStream(temporary, { flags: 'wx' }));
      if (received === 0) throw validationFailed('Пустой файл — это несостоявшаяся запись');
      await rename(temporary, path);
      return received;
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      throw cause;
    }
  }

  /** Путь файла. Ключ чужого вида или с выходом из каталога — отказ, а не догадка. */
  private pathOf(objectKey: string): string {
    if (!KEY_PATTERN.test(objectKey)) throw validationFailed('Недопустимый ключ записи');
    const path = resolve(this.root, objectKey);
    if (!path.startsWith(this.root + sep)) throw validationFailed('Недопустимый ключ записи');
    return path;
  }

  /** Недопустимый ключ — отказ промиса, как у любого другого хранилища за этим интерфейсом. */
  private signed(operation: LinkOperation, objectKey: string, ttlSeconds: number): Promise<string> {
    try {
      return Promise.resolve(this.link(operation, objectKey, ttlSeconds));
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  private link(operation: LinkOperation, objectKey: string, ttlSeconds: number): string {
    this.pathOf(objectKey);
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const query = new URLSearchParams({
      key: objectKey,
      op: operation,
      exp: String(expires),
      sig: this.sign(operation, objectKey, expires),
    });
    return `${this.baseUrl}?${query.toString()}`;
  }

  private sign(operation: LinkOperation, objectKey: string, expires: number): string {
    return createHmac('sha256', this.signingKey)
      .update(`${operation}\n${objectKey}\n${String(expires)}`)
      .digest('base64url');
  }
}
