/**
 * Резервные копии ([ADR-0086](../../../../../docs/adr/0086-rezervnye-kopii-v-kabinete.md)): только администратор.
 */

import { createReadStream } from 'node:fs';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  StreamableFile,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import type { BackupListing } from './backup-status.service.js';
import { BackupsService } from './backups.service.js';
import { backupTargetSchema, restoreSchema } from './schemas.js';
import type { QueuedRequest } from './updates.service.js';

const actorOf = (principal: Principal) => ({
  userId: principal.userId,
  role: principal.role,
  email: principal.email,
});

@Controller()
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Roles('admin')
  @Get('backups')
  list(): Promise<BackupListing> {
    return this.backups.listing();
  }

  @Roles('admin')
  @HttpCode(202)
  @Post('backups/create')
  async create(@CurrentUser() principal: Principal): Promise<{ request: QueuedRequest }> {
    return { request: await this.backups.create(actorOf(principal)) };
  }

  @Roles('admin')
  @HttpCode(202)
  @Post('backups/verify')
  async verify(
    @CurrentUser() principal: Principal,
    @Body(zodBody(backupTargetSchema)) body: z.infer<typeof backupTargetSchema>,
  ): Promise<{ request: QueuedRequest }> {
    return { request: await this.backups.verify(actorOf(principal), body.id) };
  }

  /**
   * Подготовить копию к скачиванию. Повторного пароля нет (владелец, 2026-10-19: вошёл — значит пароль уже введён);
   * защиты — журнал действий, файл выдаётся один раз и удаляется, второй фактор администратора при входе.
   */
  @Roles('admin')
  @HttpCode(202)
  @Post('backups/export')
  async requestExport(
    @CurrentUser() principal: Principal,
    @Body(zodBody(backupTargetSchema)) body: z.infer<typeof backupTargetSchema>,
  ): Promise<{ request: QueuedRequest }> {
    return { request: await this.backups.requestExport(actorOf(principal), body.id) };
  }

  /**
   * Загрузить ранее скачанную копию: тело запроса — сам файл (`application/octet-stream`). Путь под `/storage/`: у
   * nginx кабинета для него уже снят предел размера тела и выключена буферизация, отдельной настройки не требуется.
   */
  @Roles('admin')
  @HttpCode(202)
  @Put('storage/backups')
  async upload(
    @CurrentUser() principal: Principal,
    @Req() request: FastifyRequest,
    @Headers('content-length') length: string | undefined,
  ): Promise<{ request: QueuedRequest }> {
    const declared = length === undefined ? undefined : Number(length);
    return {
      request: await this.backups.receiveUpload(
        actorOf(principal),
        request.raw,
        declared === undefined || Number.isNaN(declared) ? undefined : declared,
      ),
    };
  }

  /**
   * Восстановить рабочую базу из копии. Пароль, код второго фактора и слово «ВОССТАНОВИТЬ» обязательны. Площадка
   * остановится на время восстановления; прежняя база сохраняется на диске до следующего восстановления.
   */
  @Roles('admin')
  @HttpCode(202)
  @Post('backups/restore')
  async restore(
    @CurrentUser() principal: Principal,
    @Body(zodBody(restoreSchema)) body: z.infer<typeof restoreSchema>,
  ): Promise<{ request: QueuedRequest }> {
    return {
      request: await this.backups.requestRestore(principal, body.id, {
        password: body.password,
        code: body.code,
      }),
    };
  }

  /** Скачать подготовленную копию: один раз, и только заказавшему. */
  @Roles('admin')
  @Get('backups/exports/:runId')
  async download(
    @CurrentUser() principal: Principal,
    @Param('runId') runId: string,
  ): Promise<StreamableFile> {
    const exported = await this.backups.exported(actorOf(principal), runId);
    const stream = createReadStream(exported.file);
    // Файл уходит, как только поток закрыт — дочитан или оборван: «скачать ещё раз» — новая заявка и новое подтверждение.
    stream.once('close', () => {
      void this.backups.discard(exported.file);
    });
    return new StreamableFile(stream, {
      type: 'application/octet-stream',
      disposition: `attachment; filename="zvonix-${exported.name}"`,
      length: exported.size,
    });
  }
}
