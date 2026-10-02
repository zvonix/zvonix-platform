/**
 * Выдача и приём файлов записей по подписанным ссылкам
 * ([ADR-0063](../../../../../docs/adr/0063-hranilishche-zapisey-na-diske.md)).
 *
 * Открыто для всех (`@Public()`) намеренно: права даёт подпись ссылки, которую выдала
 * площадка после проверки владения и записи в журнал (`RecordingsService`). Узел и плеер
 * браузера ходят по ссылке без сессии и без ключей.
 *
 * Подпись проверяется **до** любой работы с диском: чужой запрос не должен узнать даже,
 * есть ли такой файл.
 */

import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { notFound, permissionDenied } from '@zvonix/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../http/auth.guard.js';
import { LocalObjectStorage, type LinkOperation } from './local-storage.js';

interface SignedQuery {
  readonly key?: string;
  readonly op?: string;
  readonly exp?: string;
  readonly sig?: string;
}

/** Один диапазон `bytes=начало-конец`; прочие виды Range не поддерживаются. */
function parseRange(header: string, size: number): { start: number; end: number } | 'invalid' {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return 'invalid';
  const [, from = '', to = ''] = match;
  if (from === '' && to === '') return 'invalid';

  // «-N» — последние N байт.
  const start = from === '' ? Math.max(0, size - Number(to)) : Number(from);
  const end = from === '' || to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

@Controller('storage/recordings')
export class StorageFilesController {
  constructor(private readonly storage: LocalObjectStorage) {}

  @Public()
  @Get()
  async download(
    @Query() query: SignedQuery,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const key = this.authorize('get', query);
    const file = await this.storage.handle(key);
    if (file === undefined) throw notFound('Запись не найдена');

    // Запись — персональные данные: ни кэшей браузера, ни промежуточных.
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Accept-Ranges', 'bytes');
    const headers = { type: 'audio/wav', disposition: 'inline' } as const;

    if (range === undefined) {
      return new StreamableFile(file.open(), { ...headers, length: file.size });
    }

    const parsed = parseRange(range, file.size);
    // Диапазон, которого не понять или не выполнить, игнорируется — файл отдаётся целиком
    // (RFC 9110, 14.2): плеер переспросит, а отказ оборвал бы воспроизведение.
    if (parsed === 'invalid') {
      return new StreamableFile(file.open(), { ...headers, length: file.size });
    }
    reply.status(206);
    reply.header(
      'Content-Range',
      `bytes ${String(parsed.start)}-${String(parsed.end)}/${String(file.size)}`,
    );
    return new StreamableFile(file.open(parsed), {
      ...headers,
      length: parsed.end - parsed.start + 1,
    });
  }

  @Public()
  @Put()
  @HttpCode(200)
  async upload(
    @Query() query: SignedQuery,
    @Req() request: FastifyRequest,
  ): Promise<{ size_bytes: number }> {
    const key = this.authorize('put', query);
    return { size_bytes: await this.storage.write(key, request.raw) };
  }

  /** Ключ из ссылки, если подпись верна для этой операции и срок не вышел. */
  private authorize(operation: LinkOperation, query: SignedQuery): string {
    const { key, op, exp, sig } = query;
    if (key === undefined || op !== operation || exp === undefined || sig === undefined) {
      throw permissionDenied('Ссылка недействительна');
    }
    if (!this.storage.verify(operation, key, Number(exp), sig)) {
      throw permissionDenied('Ссылка недействительна или устарела');
    }
    return key;
  }
}
