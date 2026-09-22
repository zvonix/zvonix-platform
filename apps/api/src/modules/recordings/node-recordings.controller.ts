/**
 * Выгрузка записи узлом (ARCHITECTURE.md).
 *
 * Узел не получает ключей хранилища — только подписанную ссылку ровно на один объект
 * и на короткий срок. Ключи дали бы доступ ко всем записям всех клиентов.
 *
 * Файл идёт **напрямую в хранилище**, минуя control plane: тот не пропускает через себя
 * медиа, и гонять через него сотни мегабайт записей значило бы превратить его в узкое
 * место на ровном месте.
 */

import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { parseId } from '@zvonix/shared';
import type { z } from 'zod';
import { Machine } from '../../http/auth.guard.js';
import { CurrentMachine } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { MachinePrincipal } from '../machine/machine.service.js';
import { RecordingsService } from './recordings.service.js';
import { confirmUploadSchema, prepareUploadSchema } from './schemas.js';

@Controller('node/recordings')
export class NodeRecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  /**
   * Ссылка на выгрузку записи.
   *
   * Ключ объекта задаёт control plane. Узел его не выбирает: иначе скомпрометированный
   * узел прислал бы ключ чужой записи и затёр её.
   */
  @Machine('node')
  @Post('upload-url')
  @HttpCode(200)
  async prepareUpload(
    @Body(zodBody(prepareUploadSchema)) body: z.infer<typeof prepareUploadSchema>,
    @CurrentMachine() machine: MachinePrincipal,
  ): Promise<{ upload_url: string; object_key: string; expires_at: string }> {
    const target = await this.recordings.prepareUpload(
      parseId(body.callId, 'call'),
      parseId(machine.ownerId, 'node'),
    );

    return {
      upload_url: target.uploadUrl,
      object_key: target.objectKey,
      expires_at: target.expiresAt.toISOString(),
    };
  }

  /**
   * Отчёт о том, что файл доехал.
   *
   * До него запись считается незавершённой и не отдаётся никому: ссылка на выгрузку
   * могла быть выдана, а файл не доехать, и предлагать человеку слушать пустоту незачем.
   */
  @Machine('node')
  @Post('uploaded')
  @HttpCode(200)
  async confirmUpload(
    @Body(zodBody(confirmUploadSchema)) body: z.infer<typeof confirmUploadSchema>,
    @CurrentMachine() machine: MachinePrincipal,
  ): Promise<{ recording_id: string; uploaded_at: string | null }> {
    const confirmed = await this.recordings.confirmUpload(
      parseId(body.callId, 'call'),
      parseId(machine.ownerId, 'node'),
      { durationSeconds: body.durationSeconds, sizeBytes: BigInt(body.sizeBytes) },
    );

    return {
      recording_id: confirmed.id,
      uploaded_at: confirmed.uploadedAt?.toISOString() ?? null,
    };
  }
}
