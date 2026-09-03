/**
 * Правила работы с учётными записями и сессиями (ADR-0018).
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  newId,
  notFound,
  permissionDenied,
  rateLimited,
  unauthenticated,
  type DomainError,
  type UserRole,
  type UserStatus,
} from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { RateLimitService, type LimitRule } from '../limits/rate-limit.service.js';
import {
  IdentityRepository,
  type SessionId,
  type SessionRow,
  type UserId,
  type UserRow,
} from './identity.repository.js';
import { burnVerificationTime, hashPassword, verifyPassword } from './password.js';
import type { LoginInput, RegisterInput } from './schemas.js';
import { hashToken, issueToken, LAST_SEEN_REFRESH_MS, tokenHashEquals } from './session-token.js';

/**
 * После стольких неудач подряд вход закрывается на `LOCK_DURATION_MS`.
 * Счётчик обнуляется удачным входом.
 */
const MAX_FAILED_LOGINS = 10;
const LOCK_DURATION_MS = 15 * 60 * 1000;

/**
 * Неудачные попытки входа с одного адреса.
 *
 * Считаются **только неудачные**: удачный вход счётчик обнуляет. Иначе общий адрес
 * конторы, откуда утром входят тридцать человек, упирался бы в предел на ровном месте,
 * а перебору это не мешает — у перебирающего почти все попытки неудачны.
 *
 * Предел выбран так, чтобы человек, забывший пароль, его не заметил: десять попыток
 * подряд по одной записи уже закрывает `MAX_FAILED_LOGINS`, а двадцать с адреса — это
 * уже несколько записей, то есть перебор по списку.
 */
const LOGIN_FAILURE_RULE: LimitRule = {
  name: 'auth.login.failed',
  limit: 20,
  windowSeconds: 15 * 60,
};

/**
 * Регистрации с одного адреса.
 *
 * Здесь считаются **все** попытки, а не неудачные: смысл в том, чтобы никто не заводил
 * учётные записи пачками, и удачная попытка — как раз то, что нужно ограничить.
 * Блокировки учётной записи, которая прикрыла бы этот путь, здесь нет по построению:
 * записи ещё не существует.
 *
 * Десять в час с адреса — с запасом для конторы, где регистрируется несколько человек,
 * и тесно для того, кто заводит записи потоком.
 */
const REGISTRATION_RULE: LimitRule = {
  name: 'auth.register',
  limit: 10,
  windowSeconds: 60 * 60,
};

/** Сколько просроченных сессий удаляется за один проход фоновой уборки. */
export const SESSION_SWEEP_LIMIT = 1000;

/** Данные вызывающей стороны, установленные после проверки токена. */
export interface Principal {
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly role: UserRole;
  readonly email: string;
  readonly fullName: string;
}

/** Вид учётной записи, который безопасно отдавать наружу. */
export interface PublicUser {
  readonly id: UserId;
  readonly email: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: Date;
}

export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
  readonly user: PublicUser;
}

/**
 * Отказ по частоте.
 *
 * Срок ожидания отдаётся честно: без него клиенту остаётся только долбить наугад,
 * а это ровно та нагрузка, от которой ограничение и защищает.
 */
function tooManyAttempts(retryAfterSeconds: number): DomainError {
  return rateLimited('Слишком много попыток. Повторите позже', {
    details: { retry_after_seconds: retryAfterSeconds },
  });
}

function toPublicUser(row: UserRow): PublicUser {
  // Перечисление полей поимённо, а не `...row` без пары полей: при добавлении колонки
  // с секретом (второй фактор, хеш пароля) расширяющая запись отдала бы её наружу молча.
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class IdentityService {
  private readonly logger: Logger;

  constructor(
    private readonly repository: IdentityRepository,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('identity');
  }

  /**
   * Проверка частоты по адресу источника.
   *
   * Адрес может отсутствовать — тогда ограничивать нечего: считать все безадресные
   * запросы одним «клиентом» значит закрыть вход всем сразу при первой же аномалии.
   */
  private async assertWithinRate(rule: LimitRule, ip: string | null): Promise<void> {
    if (!this.config.AUTH_RATE_LIMIT_ENABLED || ip === null) return;

    const verdict = await this.limits.hit(rule, ip);
    if (!verdict.allowed) throw tooManyAttempts(verdict.retryAfterSeconds);
  }

  /** То же, но без засчитывания: у входа считаются только неудачи, а не обращения. */
  private async assertWithinFailureRate(rule: LimitRule, ip: string | null): Promise<void> {
    if (!this.config.AUTH_RATE_LIMIT_ENABLED || ip === null) return;

    const verdict = await this.limits.check(rule, ip);
    if (!verdict.allowed) throw tooManyAttempts(verdict.retryAfterSeconds);
  }

  private async countFailure(rule: LimitRule, ip: string | null): Promise<void> {
    if (!this.config.AUTH_RATE_LIMIT_ENABLED || ip === null) return;
    await this.limits.hit(rule, ip);
  }

  private async forgetFailures(rule: LimitRule, ip: string | null): Promise<void> {
    if (!this.config.AUTH_RATE_LIMIT_ENABLED || ip === null) return;
    await this.limits.reset(rule, ip);
  }

  /**
   * Самостоятельная регистрация клиента или партнёра.
   *
   * Запись создаётся в состоянии `pending`: партнёр проходит модерацию (DOMAIN.md),
   * а клиенту баланс заводит администратор. Роли `admin` и `support` этим путём
   * не создаются — схема запроса их не принимает.
   */
  async register(input: RegisterInput, meta: RequestMeta): Promise<PublicUser> {
    // До обращения к базе: смысл ограничения в том, чтобы поток регистраций не доходил
    // до работы, а не в том, чтобы её сосчитать.
    await this.assertWithinRate(REGISTRATION_RULE, meta.ip);

    const existing = await this.repository.findByEmail(input.email);
    if (existing !== undefined) {
      // Отдельная проверка до вставки — ради понятного сообщения. Гонку двух
      // одновременных регистраций она не закрывает; это делает уникальный индекс,
      // и его нарушение придёт сюда же как `conflict`.
      throw conflict('Учётная запись с таким адресом уже существует');
    }

    const created = await this.repository.createUser({
      id: newId<'user'>(),
      email: input.email,
      passwordHash: await hashPassword(input.password),
      fullName: input.fullName,
      role: input.role,
      status: 'pending',
    });

    await this.audit.record({
      action: 'user.registered',
      entityType: 'user',
      entityId: created.id,
      actorUserId: created.id,
      actorRole: created.role,
      after: { email: created.email, role: created.role, status: created.status },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return toPublicUser(created);
  }

  /**
   * Вход по адресу и паролю.
   *
   * Неизвестный адрес и неверный пароль дают один и тот же отказ и занимают одинаковое
   * время: иначе по ответам собирается список зарегистрированных адресов. А вот отказ
   * из-за состояния записи виден отдельно — до него доходит только тот, кто уже знает
   * верный пароль, так что перечислить чужие адреса это не помогает.
   */
  async login(input: LoginInput, meta: RequestMeta): Promise<IssuedSession> {
    const now = new Date();

    // Накопленные неудачи проверяются **до** сверки пароля: она стоит девятнадцати
    // мегабайт и заметного времени, и раздавать её тому, кто уже исчерпал предел,
    // значит отдать ему же средство нагрузить систему.
    await this.assertWithinFailureRate(LOGIN_FAILURE_RULE, meta.ip);

    const user = await this.repository.findByEmail(input.email);

    if (user === undefined) {
      await burnVerificationTime(input.password);
      await this.countFailure(LOGIN_FAILURE_RULE, meta.ip);
      throw unauthenticated('Неверный адрес или пароль');
    }

    if (user.lockedUntil !== null && user.lockedUntil > now) {
      throw permissionDenied('Вход временно закрыт из-за неудачных попыток', {
        details: { locked_until: user.lockedUntil.toISOString() },
      });
    }

    if (!(await verifyPassword(input.password, user.passwordHash))) {
      const attempts = user.failedLoginCount + 1;
      const lockUntil =
        attempts >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCK_DURATION_MS) : null;
      await this.repository.registerFailedLogin(user.id, lockUntil);
      await this.countFailure(LOGIN_FAILURE_RULE, meta.ip);

      await this.audit.record({
        action: 'session.login_failed',
        entityType: 'user',
        entityId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
        after: { attempts, locked: lockUntil !== null },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      throw unauthenticated('Неверный адрес или пароль');
    }

    if (user.status !== 'active') {
      throw permissionDenied('Учётная запись не активирована', {
        details: { status: user.status },
      });
    }

    const issued = issueToken(now);
    const session = await this.repository.createSession({
      id: newId<'session'>(),
      userId: user.id,
      tokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
      userAgent: meta.userAgent,
      ip: meta.ip,
    });

    await this.repository.registerSuccessfulLogin(user.id, now);
    // Удачный вход снимает накопленные неудачи с этого адреса: иначе общий адрес
    // конторы копил бы чужие опечатки до предела и закрывал вход всем сразу.
    await this.forgetFailures(LOGIN_FAILURE_RULE, meta.ip);

    await this.audit.record({
      action: 'session.created',
      entityType: 'session',
      entityId: session.id,
      actorUserId: user.id,
      actorRole: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { token: issued.token, expiresAt: issued.expiresAt, user: toPublicUser(user) };
  }

  /**
   * Проверка токена на каждом запросе.
   *
   * Состояние записи проверяется здесь, а не только при входе: заблокированный
   * администратором пользователь обязан терять доступ немедленно, а не через месяц,
   * когда истечёт его сессия.
   */
  async authenticate(token: string): Promise<Principal> {
    const now = new Date();
    const found = await this.repository.findLiveSession(hashToken(token), now);

    if (found === undefined) {
      throw unauthenticated('Требуется вход');
    }
    if (!tokenHashEquals(found.session.tokenHash, hashToken(token))) {
      throw unauthenticated('Требуется вход');
    }
    if (found.user.status !== 'active') {
      throw permissionDenied('Учётная запись не активна', {
        details: { status: found.user.status },
      });
    }

    if (now.getTime() - found.session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
      await this.repository.touchSession(found.session.id, now);
    }

    return {
      userId: found.user.id,
      sessionId: found.session.id,
      role: found.user.role,
      email: found.user.email,
      fullName: found.user.fullName,
    };
  }

  async logout(principal: Principal, meta: RequestMeta): Promise<void> {
    await this.repository.revokeSession(principal.sessionId, new Date());
    await this.audit.record({
      action: 'session.revoked',
      entityType: 'session',
      entityId: principal.sessionId,
      actorUserId: principal.userId,
      actorRole: principal.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async listSessions(principal: Principal): Promise<SessionRow[]> {
    return this.repository.listLiveSessions(principal.userId, new Date());
  }

  /**
   * Закрытие чужой сессии владельцем.
   *
   * Проверяется не только принадлежность роли, но и владение объектом: без этого
   * любой пользователь закрывал бы сессии любого другого, зная идентификатор.
   */
  async revokeSession(principal: Principal, sessionId: SessionId): Promise<void> {
    const own = await this.repository.listLiveSessions(principal.userId, new Date());
    if (!own.some((session) => session.id === sessionId)) {
      // `not_found`, а не `permission_denied`: иначе по разнице ответов проверяется
      // существование чужих сессий.
      throw notFound('Сессия не найдена');
    }

    await this.repository.revokeSession(sessionId, new Date());
    await this.audit.record({
      action: 'session.revoked',
      entityType: 'session',
      entityId: sessionId,
      actorUserId: principal.userId,
      actorRole: principal.role,
    });
  }

  /**
   * Уборка просроченных сессий (ADR-0020).
   *
   * Работающему доступу они не мешают: `authenticate` и так проверяет срок. Но сессия
   * хранит адрес и клиента — данные о человеке, — и держать их после того, как сессия
   * перестала действовать, значит хранить персональные данные без причины.
   *
   * Отбирает по сроку, а не «с прошлого запуска»: пропущенный тик ничего не теряет.
   */
  async purgeExpiredSessions(now: Date = new Date()): Promise<number> {
    const removed = await this.repository.deleteExpiredSessions(now, SESSION_SWEEP_LIMIT);
    if (removed > 0) {
      this.logger.info('Удалены просроченные сессии', { count: removed });
    }
    return removed;
  }

  async findPublicUser(id: UserId): Promise<PublicUser> {
    const row = await this.repository.findById(id);
    if (row === undefined) throw notFound('Учётная запись не найдена');
    return toPublicUser(row);
  }

  /**
   * Изменение состояния учётной записи администратором: активация после модерации,
   * приостановка, закрытие.
   *
   * Снятие активности немедленно закрывает все сессии — иначе заблокированный
   * пользователь продолжает работать до истечения своего токена.
   */
  async changeStatus(
    actor: Principal,
    id: UserId,
    status: UserStatus,
    meta: RequestMeta,
  ): Promise<PublicUser> {
    const target = await this.repository.findById(id);
    if (target === undefined) throw notFound('Учётная запись не найдена');

    if (target.status === status) return toPublicUser(target);

    const updated = await this.repository.setStatus(id, status);
    const revoked =
      status === 'active' ? 0 : await this.repository.revokeAllSessions(id, new Date());

    await this.audit.record({
      action: 'user.status_changed',
      entityType: 'user',
      entityId: id,
      actorUserId: actor.userId,
      actorRole: actor.role,
      before: { status: target.status },
      after: { status, revoked_sessions: revoked },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return toPublicUser(updated);
  }

  /** Создание учётной записи администратором: роли `admin` и `support` заводятся только так. */
  async createByAdmin(draft: {
    email: string;
    password: string;
    fullName: string;
    role: UserRole;
    status: UserStatus;
  }): Promise<PublicUser> {
    const existing = await this.repository.findByEmail(draft.email);
    if (existing !== undefined) throw conflict('Учётная запись с таким адресом уже существует');

    const created = await this.repository.createUser({
      id: newId<'user'>(),
      email: draft.email,
      passwordHash: await hashPassword(draft.password),
      fullName: draft.fullName,
      role: draft.role,
      status: draft.status,
    });
    return toPublicUser(created);
  }
}
