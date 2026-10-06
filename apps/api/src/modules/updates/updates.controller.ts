/**
 * Обновление из кабинета ([ADR-0074](../../../../../docs/adr/0074-obnovlenie-iz-adminki.md)): только администратор.
 */

import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody, zodQuery } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { deployRequestSchema, logQuerySchema } from './schemas.js';
import {
  UpdatesService,
  type LogChunk,
  type QueuedRequest,
  type UpdatesOverview,
} from './updates.service.js';

@Controller()
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}

  @Roles('admin')
  @Get('updates')
  overview(): Promise<UpdatesOverview> {
    return this.updates.overview();
  }

  @Roles('admin')
  @HttpCode(202)
  @Post('updates/deploy')
  async deploy(
    @CurrentUser() actor: Principal,
    @Body(zodBody(deployRequestSchema)) body: z.infer<typeof deployRequestSchema>,
  ): Promise<{ request: QueuedRequest }> {
    return { request: await this.updates.request(actor, 'deploy', body.tag) };
  }

  @Roles('admin')
  @HttpCode(202)
  @Post('updates/rollback')
  async rollback(@CurrentUser() actor: Principal): Promise<{ request: QueuedRequest }> {
    return { request: await this.updates.request(actor, 'rollback', null) };
  }

  @Roles('admin')
  @HttpCode(202)
  @Post('updates/refresh')
  async refresh(@CurrentUser() actor: Principal): Promise<{ request: QueuedRequest }> {
    return { request: await this.updates.request(actor, 'refresh', null) };
  }

  @Roles('admin')
  @HttpCode(204)
  @Post('updates/:id/cancel')
  async cancel(@CurrentUser() actor: Principal, @Param('id') id: string): Promise<void> {
    await this.updates.cancel(actor, id);
  }

  @Roles('admin')
  @Get('updates/:id/log')
  log(
    @Param('id') id: string,
    @Query(zodQuery(logQuerySchema)) query: z.infer<typeof logQuerySchema>,
  ): Promise<LogChunk> {
    return this.updates.log(id, query.offset);
  }
}
