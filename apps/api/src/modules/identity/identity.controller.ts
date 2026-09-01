/**
 * HTTP-контракт учётных записей.
 *
 * Контроллер только разбирает вход, вызывает сервис и раскладывает ответ.
 * Логики здесь нет: она проверяется тестами сервиса, а не через HTTP.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { parseId, type UserStatus } from '@zvonix/shared';
import { z } from 'zod';
import { Public, Roles } from '../../http/auth.guard.js';
import { CurrentUser, Meta } from '../../http/request-context.js';
import { zodBody } from '../../http/zod.pipe.js';
import { IdentityService, type Principal, type RequestMeta } from './identity.service.js';
import type { LoginResponse, SessionResponse, UserResponse } from './responses.js';
import { loginSchema, registerSchema } from './schemas.js';

const statusSchema = z.object({
  status: z.enum(['pending', 'active', 'suspended', 'disabled']),
});

@Controller()
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Public()
  @Post('auth/register')
  async register(
    @Body(zodBody(registerSchema)) body: z.infer<typeof registerSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<{ user: UserResponse }> {
    const user = await this.identity.register(body, meta);
    return { user };
  }

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body(zodBody(loginSchema)) body: z.infer<typeof loginSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<LoginResponse> {
    const issued = await this.identity.login(body, meta);
    return {
      // Токен отдаётся один раз и нигде больше не появляется: в базе лежит его хеш.
      token: issued.token,
      expires_at: issued.expiresAt.toISOString(),
      user: issued.user,
    };
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@CurrentUser() principal: Principal, @Meta() meta: RequestMeta): Promise<void> {
    await this.identity.logout(principal, meta);
  }

  @Get('auth/me')
  async me(@CurrentUser() principal: Principal): Promise<{ user: UserResponse }> {
    return { user: await this.identity.findPublicUser(principal.userId) };
  }

  @Get('auth/sessions')
  async sessions(@CurrentUser() principal: Principal): Promise<{ sessions: SessionResponse[] }> {
    const rows = await this.identity.listSessions(principal);
    return {
      // Хеш токена наружу не отдаётся ни при каких условиях.
      sessions: rows.map((row) => ({
        id: row.id,
        current: row.id === principal.sessionId,
        ip: row.ip,
        user_agent: row.userAgent,
        created_at: row.createdAt.toISOString(),
        last_seen_at: row.lastSeenAt.toISOString(),
        expires_at: row.expiresAt.toISOString(),
      })),
    };
  }

  @Delete('auth/sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    await this.identity.revokeSession(principal, parseId(id, 'session'));
  }

  @Roles('admin')
  @Patch('users/:id/status')
  async changeStatus(
    @CurrentUser() actor: Principal,
    @Param('id') id: string,
    @Body(zodBody(statusSchema)) body: { status: UserStatus },
    @Meta() meta: RequestMeta,
  ): Promise<{ user: UserResponse }> {
    const user = await this.identity.changeStatus(actor, parseId(id, 'user'), body.status, meta);
    return { user };
  }
}
