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
import {
  changePasswordSchema,
  disableTotpSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerSchema,
  tokenSchema,
  totpCodeSchema,
} from './schemas.js';

const statusSchema = z.object({
  status: z.enum(['pending', 'active', 'suspended', 'disabled']),
});

@Controller()
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  /**
   * Самостоятельная регистрация.
   *
   * Отвечает `202` всегда — и когда запись создана, и когда адрес занят: разница
   * в ответе была бы способом перебрать адреса. Что произошло на самом деле, человек
   * узнаёт из письма ([ADR-0029](../../../../../docs/adr/0029-pochta.md)).
   */
  @Public()
  @HttpCode(202)
  @Post('auth/register')
  async register(
    @Body(zodBody(registerSchema)) body: z.infer<typeof registerSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.identity.register(body, meta);
  }

  /**
   * Запрос восстановления пароля.
   *
   * `202` всегда: ответ не должен зависеть от того, есть ли такая запись, — иначе
   * по нему перебирают адреса.
   */
  @Public()
  @HttpCode(202)
  @Post('auth/password-reset')
  async requestPasswordReset(
    @Body(zodBody(passwordResetRequestSchema)) body: z.infer<typeof passwordResetRequestSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.identity.requestPasswordReset(body.email, meta);
  }

  /**
   * Смена пароля по ссылке из письма.
   *
   * Закрываются **все** сессии, включая текущую: пароль восстанавливают, когда доступ
   * потерян.
   */
  @Public()
  @HttpCode(204)
  @Post('auth/password-reset/confirm')
  async confirmPasswordReset(
    @Body(zodBody(passwordResetConfirmSchema)) body: z.infer<typeof passwordResetConfirmSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.identity.confirmPasswordReset(body.token, body.newPassword, meta);
  }

  /** Подтверждение адреса по ссылке. Доступ не открывает — это дело администратора. */
  @Public()
  @HttpCode(204)
  @Post('auth/email/confirm')
  async confirmEmail(
    @Body(zodBody(tokenSchema)) body: z.infer<typeof tokenSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.identity.confirmEmail(body.token, meta);
  }

  /** Повторное письмо с подтверждением — тому, кто уже вошёл. */
  @HttpCode(202)
  @Post('auth/email/resend')
  async resendEmailVerification(@CurrentUser() principal: Principal): Promise<void> {
    await this.identity.resendEmailVerification(principal);
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

  /**
   * Смена пароля из кабинета.
   *
   * Текущий пароль обязателен, прочие сессии закрываются, текущая остаётся
   * ([ADR-0028](../../../../../docs/adr/0028-vtoroy-faktor.md)).
   */
  @Post('auth/password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() principal: Principal,
    @Body(zodBody(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<{ revoked_sessions: number }> {
    const result = await this.identity.changePassword(principal, body, meta);
    return { revoked_sessions: result.revokedSessions };
  }

  /**
   * Начинает подключение второго фактора.
   *
   * Секрет отдаётся **один раз** и только здесь: восстановить его неоткуда — в базе он
   * лежит зашифрованным. До подтверждения кодом фактор не действует.
   */
  @Post('auth/totp')
  @HttpCode(200)
  async startTotp(
    @CurrentUser() principal: Principal,
  ): Promise<{ secret: string; otpauth_uri: string }> {
    const enrolment = await this.identity.startTotpEnrolment(principal);
    return { secret: enrolment.secret, otpauth_uri: enrolment.uri };
  }

  /** Подтверждает подключение кодом: без этого второй фактор не включается. */
  @Post('auth/totp/confirm')
  @HttpCode(204)
  async confirmTotp(
    @CurrentUser() principal: Principal,
    @Body(zodBody(totpCodeSchema)) body: z.infer<typeof totpCodeSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.identity.confirmTotp(principal, body.code, meta);
  }

  /** Отключение: и пароль, и код — одной украденной сессии для снятия защиты мало. */
  @Delete('auth/totp')
  @HttpCode(204)
  async disableTotp(
    @CurrentUser() principal: Principal,
    @Body(zodBody(disableTotpSchema)) body: z.infer<typeof disableTotpSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.identity.disableTotp(principal, body, meta);
  }

  /**
   * Сброс второго фактора администратором — путь назад при потерянном телефоне.
   *
   * Кодов восстановления нет намеренно: это ещё один секрет, который люди хранят рядом
   * с паролем. Здесь путь назад — человек, и его действие остаётся в журнале (ADR-0028).
   */
  @Roles('admin')
  @Delete('users/:id/totp')
  @HttpCode(204)
  async resetTotp(@CurrentUser() actor: Principal, @Param('id') id: string): Promise<void> {
    await this.identity.resetTotp(parseId(id, 'user'), actor.userId, actor.role);
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
