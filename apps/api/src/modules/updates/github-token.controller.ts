/**
 * Токен GitHub для обновлений ([ADR-0084](../../../../../docs/adr/0084-token-github-v-nastroykah.md)): только администратор.
 */

import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { z } from 'zod';
import { Roles } from '../../http/auth.guard.js';
import { CurrentUser } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import type { Principal } from '../identity/identity.service.js';
import { GithubTokenService, type GithubTokenView } from './github-token.service.js';
import { githubTokenSchema } from './schemas.js';
import type { QueuedRequest } from './updates.service.js';

@Controller()
export class GithubTokenController {
  constructor(private readonly githubToken: GithubTokenService) {}

  /** Состояние токена. Самого токена в ответе нет и быть не может. */
  @Roles('admin')
  @Get('updates/github-token')
  view(): Promise<GithubTokenView> {
    return this.githubToken.view();
  }

  @Roles('admin')
  @HttpCode(202)
  @Post('updates/github-token')
  async set(
    @CurrentUser() actor: Principal,
    @Body(zodBody(githubTokenSchema)) body: z.infer<typeof githubTokenSchema>,
  ): Promise<{ request: QueuedRequest }> {
    return { request: await this.githubToken.set(actor, body.token) };
  }
}
