/**
 * Проверка токена и роли на входе в обработчик.
 *
 * Оба защитника глобальные: доступ по умолчанию закрыт, и открывается он явной
 * пометкой `@Public()`. Обратный порядок — «по умолчанию открыто, закрываем нужное» —
 * рано или поздно оставляет незакрытым один обработчик, и узнают об этом не первыми.
 */

import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  permissionDenied,
  unauthenticated,
  type MachineKeyKind,
  type UserRole,
} from '@zvonix/shared';
import type { FastifyRequest } from 'fastify';
import { IdentityService, type Principal } from '../modules/identity/identity.service.js';
import { readBearer } from '../modules/identity/session-token.js';
import { readMachineKey } from '../modules/machine/machine-key.js';
import { MachineService, type MachinePrincipal } from '../modules/machine/machine.service.js';

const PUBLIC_KEY = 'zvonix:public';
const ROLES_KEY = 'zvonix:roles';
const MACHINE_KEY = 'zvonix:machine';

/** Обработчик доступен без входа: регистрация, вход, проверка живости. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** Обработчик доступен только перечисленным ролям. */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Обработчик машинного контура: узел АТС или клиентская интеграция (ADR-0019).
 *
 * Помеченный обработчик проверяется **только** по машинному ключу и человеческой сессией
 * не открывается. Обратное тоже верно: ключ машины не открывает ни одного обработчика,
 * помеченного ролью, — иначе украденный с узла ключ становится администратором платформы.
 */
export const Machine = (...kinds: MachineKeyKind[]): MethodDecorator & ClassDecorator =>
  SetMetadata(MACHINE_KEY, kinds);

/** Запрос с уже проверенной вызывающей стороной: человеком либо машиной, но не обоими. */
export interface AuthenticatedRequest extends FastifyRequest {
  principal?: Principal;
  machine?: MachinePrincipal;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityService,
    private readonly machine: MachineService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const machineKinds = this.reflector.getAllAndOverride<MachineKeyKind[] | undefined>(
      MACHINE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (machineKinds !== undefined) {
      return this.authenticateMachine(request, machineKinds);
    }

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

  /**
   * Машинный контур.
   *
   * `request.ip` учитывает `X-Forwarded-For` только при включённом `trustProxy` —
   * без него за обратным прокси в список разрешённых адресов попал бы адрес прокси,
   * и ограничение по адресу перестало бы что-либо ограничивать.
   */
  private async authenticateMachine(
    request: AuthenticatedRequest,
    allowedKinds: readonly MachineKeyKind[],
  ): Promise<boolean> {
    const presented = readMachineKey(request.headers.authorization);
    if (presented === undefined) {
      throw unauthenticated('Требуется машинный ключ');
    }

    const principal = await this.machine.authenticate(presented, request.ip);
    if (allowedKinds.length > 0 && !allowedKinds.includes(principal.kind)) {
      throw permissionDenied('Ключ не того вида');
    }

    request.machine = principal;
    return true;
  }
}
