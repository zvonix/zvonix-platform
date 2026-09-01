/**
 * Проверка токена и роли на входе в обработчик.
 *
 * Оба защитника глобальные: доступ по умолчанию закрыт, и открывается он явной
 * пометкой `@Public()`. Обратный порядок — «по умолчанию открыто, закрываем нужное» —
 * рано или поздно оставляет незакрытым один обработчик, и узнают об этом не первыми.
 */

import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { permissionDenied, unauthenticated, type UserRole } from '@zvonix/shared';
import type { FastifyRequest } from 'fastify';
import { IdentityService, type Principal } from '../modules/identity/identity.service.js';
import { readBearer } from '../modules/identity/session-token.js';

const PUBLIC_KEY = 'zvonix:public';
const ROLES_KEY = 'zvonix:roles';

/** Обработчик доступен без входа: регистрация, вход, проверка живости. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** Обработчик доступен только перечисленным ролям. */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/** Запрос с уже проверенной вызывающей стороной. */
export interface AuthenticatedRequest extends FastifyRequest {
  principal?: Principal;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readBearer(request.headers.authorization);
    if (token === undefined) {
      throw unauthenticated('Требуется вход');
    }

    const principal = await this.identity.authenticate(token);
    request.principal = principal;

    const allowed = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed !== undefined && allowed.length > 0 && !allowed.includes(principal.role)) {
      // Роль — только первый рубеж. Владение конкретным объектом проверяет сервис:
      // партнёр не должен видеть чужие звонки, а клиент — чужие записи.
      throw permissionDenied('Недостаточно прав');
    }

    return true;
  }
}
