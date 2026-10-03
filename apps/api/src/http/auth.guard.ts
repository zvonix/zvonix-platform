/**
 * Проверка токена и роли на входе в обработчик.
 *
 * Оба защитника глобальные: доступ по умолчанию закрыт, и открывается он явной
 * пометкой `@Public()`. Обратный порядок — «по умолчанию открыто, закрываем нужное» —
 * рано или поздно оставляет незакрытым один обработчик, и узнают об этом не первыми.
 */

import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  isStaffRole,
  permissionDenied,
  unauthenticated,
  type Cabinet,
  type MachineKeyKind,
  type UserRole,
} from '@zvonix/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG, type Config } from '../infra/tokens.js';
import { BillingService } from '../modules/billing/billing.service.js';
import { IdentityService, type Principal } from '../modules/identity/identity.service.js';
import { readBearer } from '../modules/identity/session-token.js';
import { readMachineKey } from '../modules/machine/machine-key.js';
import { MachineService, type MachinePrincipal } from '../modules/machine/machine.service.js';
import {
  CSRF_HEADER,
  clearSessionCookie,
  isSafeMethod,
  readSessionCookie,
  secureCookies,
} from './session-cookie.js';

/**
 * Ключи пометок. `PUBLIC_KEY` и `MACHINE_KEY` вынесены наружу для второго глобального
 * защитника — предела частоты изменений ([ADR-0041](../../../../docs/adr/0041-predel-chastoty-izmeneniy.md)):
 * он обязан пропускать ровно то же, что помечено здесь, и второе перечисление тех же
 * строк разошлось бы с этим на первой же правке.
 */
export const PUBLIC_KEY = 'zvonix:public';
const ROLES_KEY = 'zvonix:roles';
const CABINETS_KEY = 'zvonix:cabinets';

const CABINET_GENITIVE: Record<Cabinet, string> = { client: 'клиента', partner: 'партнёра' };
export const MACHINE_KEY = 'zvonix:machine';
export const UNMETERED_KEY = 'zvonix:unmetered';
const WITHOUT_SECOND_FACTOR_KEY = 'zvonix:without-second-factor';

/** Обработчик доступен без входа: регистрация, вход, проверка живости. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/**
 * Обработчик открыт администратору, которому политика требует второй фактор, а он ещё не
 * подключён ([ADR-0067](../../../../docs/adr/0067-vtoroy-faktor-administratoram.md)): только то, без чего
 * подключить его нельзя — узнать себя, подключить, выйти. Остальное закрыто.
 */
export const AllowWithoutSecondFactor = (): MethodDecorator & ClassDecorator =>
  SetMetadata(WITHOUT_SECOND_FACTOR_KEY, true);

/** Обработчик доступен только перечисленным ролям. */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Обработчик открыт участнику рынка, у которого есть кабинет одного из перечисленных
 * видов ([ADR-0052](../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 *
 * Кабинет открывает **владение** карточкой клиента или партнёра, а не роль: у участника
 * роль одна на оба кабинета. Рядом с `@Roles` пометки складываются через «или» —
 * `@Roles('admin', 'support') @Cabinets('client')` пускает сотрудника и клиента.
 * Сотрудника площадки эта пометка не пускает никогда: кабинетов у него нет.
 */
export const Cabinets = (...cabinets: Cabinet[]): MethodDecorator & ClassDecorator =>
  SetMetadata(CABINETS_KEY, cabinets);

/**
 * Обработчик машинного контура: узел АТС или клиентская интеграция (ADR-0019).
 *
 * Помеченный обработчик проверяется **только** по машинному ключу и человеческой сессией
 * не открывается. Обратное тоже верно: ключ машины не открывает ни одного обработчика,
 * помеченного ролью, — иначе украденный с узла ключ становится администратором платформы.
 */
export const Machine = (...kinds: MachineKeyKind[]): MethodDecorator & ClassDecorator =>
  SetMetadata(MACHINE_KEY, kinds);

/**
 * Обработчик не попадает под предел частоты изменений
 * ([ADR-0041](../../../../docs/adr/0041-predel-chastoty-izmeneniy.md)).
 *
 * Ставится не ради удобства, а там, где притормаживание опасно: **выход и закрытие
 * сессий**. Человек, чья сессия захвачена, обязан суметь её оборвать — и именно
 * в этот момент счётчик изменений у него исчерпан чужими руками. Предел объёма,
 * запирающий дверь наружу, защищает не того.
 */
export const Unmetered = (): MethodDecorator & ClassDecorator => SetMetadata(UNMETERED_KEY, true);

/** Запрос с уже проверенной вызывающей стороной: человеком либо машиной, но не обоими. */
export interface AuthenticatedRequest extends FastifyRequest {
  principal?: Principal;
  machine?: MachinePrincipal;
}

@Injectable()
export class AuthGuard implements CanActivate {
  /** Признак `Secure` у cookie: он же выбирает её имя (ADR-0037). */
  private readonly secure: boolean;

  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityService,
    private readonly machine: MachineService,
    private readonly billing: BillingService,
    @Inject(APP_CONFIG) config: Config,
  ) {
    this.secure = secureCookies(config);
  }

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

    const principal = await this.authenticateHuman(request, context);
    request.principal = principal;

    const targets = [context.getHandler(), context.getClass()];
    if (
      principal.secondFactorRequired &&
      this.reflector.getAllAndOverride<boolean | undefined>(WITHOUT_SECOND_FACTOR_KEY, targets) !==
        true
    ) {
      throw permissionDenied('Администратору нужно подключить второй фактор', {
        details: { reason: 'second_factor_required' },
      });
    }
    const roles =
      this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, targets) ?? [];
    const cabinets =
      this.reflector.getAllAndOverride<Cabinet[] | undefined>(CABINETS_KEY, targets) ?? [];
    if (roles.length === 0 && cabinets.length === 0) return true;

    if (roles.includes(principal.role)) return true;
    if (cabinets.length > 0 && !isStaffRole(principal.role)) {
      const owned = await this.billing.cabinetsOf(principal.userId);
      if (cabinets.some((cabinet) => owned[cabinet] !== undefined)) return true;
    }

    // Роль и кабинет — только первый рубеж. Владение конкретным объектом проверяет
    // сервис: партнёр не должен видеть чужие звонки, а клиент — чужие записи.
    //
    // Участнику без нужной карточки отказ называет причину: это не «чужое», а
    // незавершённое подключение, и человек должен понять, что ему нужна заявка.
    const [only] = cabinets;
    if (cabinets.length === 1 && only !== undefined && !isStaffRole(principal.role)) {
      throw permissionDenied(`Кабинет ${CABINET_GENITIVE[only]} не подключён`, {
        details: { cabinet: only },
      });
    }
    throw permissionDenied('Недостаточно прав');
  }

  /**
   * Человеческая сессия: заголовок `Bearer` либо cookie
   * ([ADR-0037](../../../../docs/adr/0037-sessiya-v-brauzere.md)).
   *
   * Порядок важен. `Bearer` идёт первым: у него нет ни CSRF, ни привязки к браузеру,
   * и запрос, явно назвавший токен, должен разбираться именно по нему — иначе
   * забытая в браузере cookie молча подменяла бы токен из заголовка.
   */
  private async authenticateHuman(
    request: AuthenticatedRequest,
    context: ExecutionContext,
  ): Promise<Principal> {
    const bearer = readBearer(request.headers.authorization);
    const cookie =
      bearer === undefined ? readSessionCookie(request.headers.cookie, this.secure) : undefined;

    const token = bearer ?? cookie;
    if (token === undefined) {
      throw unauthenticated('Требуется вход');
    }

    // Проверка CSRF идёт до проверки токена: она дешевле и не должна зависеть
    // от того, годная сессия или нет.
    if (cookie !== undefined && !isSafeMethod(request.method)) {
      if (request.headers[CSRF_HEADER] === undefined) {
        throw permissionDenied('Запрос из браузера без заголовка X-Zvonix-Web');
      }
    }

    try {
      return await this.identity.authenticate(token);
    } catch (cause) {
      // Негодная cookie — мусор в браузере, а не ошибка вызывающего: без снятия
      // кабинет получал бы отказ на каждом запросе, пока человек не почистит
      // хранилище сайта руками.
      if (cookie !== undefined) {
        const reply = context.switchToHttp().getResponse<FastifyReply>();
        void reply.header('set-cookie', clearSessionCookie(this.secure));
      }
      throw cause;
    }
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

    // Вид ключа проверяется внутри `verify`, а не здесь: иначе отказ по виду отличался бы
    // по ответу от отказа по секрету, и по разнице выяснялось бы, какой ключ существует.
    request.machine = await this.machine.verify(presented, request.ip, allowedKinds);
    return true;
  }
}
