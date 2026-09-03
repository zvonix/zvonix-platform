/**
 * Правила работы с учётными записями и сессиями (ADR-0018).
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  conflict,
  newId,
  notFound,
  DomainError,
  internal as internalError,
  permissionDenied,
  rateLimited,
  unauthenticated,
  validationFailed,
  type UserRole,
  type UserStatus,
} from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { RateLimitService, type LimitRule } from '../limits/rate-limit.service.js';
import { MailService } from '../mail/mail.service.js';
import {
  IdentityRepository,
  type SessionId,
  type SessionRow,
  type UserId,
  type UserRow,
} from './identity.repository.js';
import { burnVerificationTime, hashPassword, verifyPassword } from './password.js';
import {
  emailVerificationLetter,
  passwordResetLetter,
  registrationAttemptLetter,
} from './letters.js';
import { decryptSecret, encryptSecret } from './secret-box.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';
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

/**
 * Сколько раз можно ошибиться текущим паролем при его смене.
 *
 * Считается по пользователю, а не по адресу: сюда приходят с уже действующей сессией,
 * и защищаемся мы не от перебора учётной записи, а от перебора **пароля** тем, кто
 * завладел сессией, — и заодно от девятнадцати мегабайт на каждую попытку.
 */
const PASSWORD_CHANGE_RULE: LimitRule = {
  name: 'auth.password.change',
  limit: 10,
  windowSeconds: 15 * 60,
};

/**
 * Сколько живёт ссылка восстановления пароля.
 *
 * Два часа: человек читает почту не мгновенно, но письмо недельной давности, попавшее
 * не в те руки, не должно открывать вход.
 */
const PASSWORD_RESET_TTL_HOURS = 2;

/** Сколько живёт ссылка подтверждения адреса. Сутки: спешить тут некуда. */
const EMAIL_VERIFICATION_TTL_HOURS = 24;

/**
 * Сколько запросов восстановления принимается с адреса за час.
 *
 * Каждый запрос — письмо, и без предела чужой почтовый ящик заваливается письмами
 * от нашего имени.
 */
const PASSWORD_RESET_RULE: LimitRule = {
  name: 'auth.password.reset',
  limit: 5,
  windowSeconds: 60 * 60,
};

/**
 * Сколько раз можно попросить повторное письмо с подтверждением адреса.
 *
 * Считается по записи, а не по адресу источника: сюда приходят с действующей сессией.
 * Без предела обработчик вызывается в цикле, и каждый вызов — письмо
 * ([ADR-0030](../../../../../docs/adr/0030-predel-pisem-na-adres.md)).
 */
const EMAIL_RESEND_RULE: LimitRule = {
  name: 'auth.email.resend',
  limit: 5,
  windowSeconds: 60 * 60,
};

/** Имя площадки в ссылке `otpauth://`: под ним запись видна в аутентификаторе. */
const TOTP_ISSUER = 'Zvonix';

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
    private readonly mail: MailService,
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
  /**
   * Самостоятельная регистрация.
   *
   * Ничего не возвращает и отвечает одинаково независимо от того, был ли адрес занят
   * ([ADR-0029](../../../../../docs/adr/0029-pochta.md)). Разница уходит в письмо:
   * новому адресу — подтверждение, занятому — «на ваш адрес пытались
   * зарегистрироваться». Так человек, чей адрес взяли чужие, об этом узнаёт,
   * а перебор адресов перестаёт работать.
   */
  async register(input: RegisterInput, meta: RequestMeta): Promise<void> {
    // До обращения к базе: смысл ограничения в том, чтобы поток регистраций не доходил
    // до работы, а не в том, чтобы её сосчитать.
    await this.assertWithinRate(REGISTRATION_RULE, meta.ip);

    const now = new Date();
    const existing = await this.repository.findByEmail(input.email);

    if (existing !== undefined) {
      // Пароль всё равно хешируется: без этого ответ на занятый адрес приходит заметно
      // быстрее, и адреса перебираются по времени ответа, а не по коду.
      await burnVerificationTime(input.password);
      await this.mail.enqueue({
        recipient: existing.email,
        ...registrationAttemptLetter(this.config.WEB_BASE_URL),
      });

      await this.audit.record({
        action: 'user.registration_attempt',
        entityType: 'user',
        entityId: existing.id,
        actorUserId: null,
        actorRole: null,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return;
    }

    let created: UserRow;
    try {
      created = await this.repository.createUser({
        id: newId<'user'>(),
        email: input.email,
        passwordHash: await hashPassword(input.password),
        fullName: input.fullName,
        role: input.role,
        status: 'pending',
      });
    } catch (cause) {
      // Гонку двух одновременных регистраций закрывает уникальный индекс. Наружу
      // она тоже не должна быть видна: ответ обязан не зависеть от занятости адреса.
      if (cause instanceof DomainError && cause.code === 'conflict') return;
      throw cause;
    }

    // Исход не проверяется намеренно: ответ на регистрацию обязан быть одинаковым
    // независимо ни от чего (ADR-0029). Не ушедшее письмо видно в журнале, а человек
    // может попросить его заново.
    await this.sendEmailVerification(created, now);

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

    // Второй фактор спрашивается **после** верной сверки пароля: иначе по ответу видно,
    // у кого он включён, то есть кого имеет смысл атаковать иначе (ADR-0028).
    if (user.totpConfirmedAt !== null && user.totpSecret !== null) {
      const step = await this.acceptTotp(user, input.totpCode, now);
      if (step === undefined) {
        // Неверный код — такая же неудача входа, как неверный пароль: и счётчик
        // по адресу, и блокировка записи работают одинаково.
        const attempts = user.failedLoginCount + 1;
        const lockUntil =
          attempts >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCK_DURATION_MS) : null;
        await this.repository.registerFailedLogin(user.id, lockUntil);
        await this.countFailure(LOGIN_FAILURE_RULE, meta.ip);

        await this.audit.record({
          action: 'session.totp_failed',
          entityType: 'user',
          entityId: user.id,
          actorUserId: user.id,
          actorRole: user.role,
          after: { provided: input.totpCode !== undefined, locked: lockUntil !== null },
          ip: meta.ip,
          userAgent: meta.userAgent,
        });

        throw unauthenticated(
          input.totpCode === undefined ? 'Нужен код второго фактора' : 'Неверный код',
          { details: { totp_required: true } },
        );
      }
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
   * Принимает код второго фактора и запоминает его шаг.
   *
   * Шаг записывается условием «больше записанного» в том же запросе: без этого два
   * одновременных входа с одним кодом оба прошли бы проверку — то есть повторное
   * использование, ради запрета которого шаг и хранится (ADR-0028).
   */
  private async acceptTotp(
    user: UserRow,
    code: string | undefined,
    now: Date,
  ): Promise<number | undefined> {
    if (code === undefined || user.totpSecret === null) return undefined;

    const secret = this.readTotpSecret(user);
    const step = verifyTotp(secret, code, now, {
      ...(user.totpLastStep === null ? {} : { minStep: user.totpLastStep }),
    });
    if (step === undefined) return undefined;

    return (await this.repository.markTotpStep(user.id, step)) ? step : undefined;
  }

  /**
   * Расшифровывает секрет второго фактора.
   *
   * Ошибка не проглатывается: невозможность расшифровать означает смену ключа или порчу
   * данных, и в обоих случаях второй фактор у человека не работает. Пустить его без кода
   * значило бы отключить защиту, о которой он не знает.
   */
  private readTotpSecret(user: UserRow): string {
    if (user.totpSecret === null) throw internalError('У записи нет секрета второго фактора');
    try {
      return decryptSecret(user.totpSecret, this.config.SECRET_KEY);
    } catch (cause) {
      this.logger.error('Секрет второго фактора не расшифровывается', cause, {
        user_id: user.id,
      });
      throw internalError('Второй фактор не работает: обратитесь к администратору');
    }
  }

  // --- Восстановление пароля и подтверждение адреса (ADR-0029) ----------------------

  /**
   * Запрос восстановления пароля.
   *
   * Отвечает одинаково независимо от того, есть ли такая запись: разница в ответе —
   * это способ перебрать адреса, а он закрыт везде, включая вход.
   *
   * Токен и письмо о нём пишутся **одной транзакцией**: иначе возможны «токен есть,
   * письма нет» и «письмо ушло, токена нет».
   */
  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    await this.assertWithinRate(PASSWORD_RESET_RULE, meta.ip);

    const user = await this.repository.findByEmail(email);
    // Записи нет или доступ к ней закрыт — молчим. Письмо о том, что «такого адреса
    // у нас нет», сообщало бы ровно то, что мы скрываем.
    if (user === undefined || user.status === 'disabled') return;

    const now = new Date();
    const issued = issueToken(now, PASSWORD_RESET_TTL_HOURS * 3_600_000);
    const letter = passwordResetLetter(
      this.config.WEB_BASE_URL,
      issued.token,
      PASSWORD_RESET_TTL_HOURS,
    );

    // Исход возвращается из транзакции, а не через переменную снаружи: при внешней
    // переменной проверка «письмо ушло?» неотличима от заведомо ложной — присваивание
    // происходит в замыкании, и сузить её тип по нему нельзя.
    const queued = await this.repository.db.transaction(async (tx) => {
      // Место на адрес спрашивается ДО записи токена: заявка, чьё письмо всё равно
      // не уйдёт, не должна гасить действующую ссылку человека
      // ([ADR-0030](../../../../../docs/adr/0030-predel-pisem-na-adres.md)).
      if (!(await this.mail.canSendTo(user.email, now, tx)).allowed) return false;

      // Прежние ссылки гаснут: письмо недельной давности не должно работать наравне
      // со свежим.
      await this.repository.expireAuthTokens(user.id, 'password_reset', now, tx);
      await this.repository.createAuthToken(
        {
          userId: user.id,
          purpose: 'password_reset',
          tokenHash: issued.tokenHash,
          expiresAt: issued.expiresAt,
        },
        tx,
      );
      return this.mail.enqueue({ recipient: user.email, ...letter }, tx);
    });

    // Ответ при этом не меняется: он обязан не зависеть ни от существования записи,
    // ни от того, сколько писем уже ушло на этот адрес (ADR-0029).
    if (!queued) return;

    await this.audit.record({
      action: 'user.password_reset_requested',
      entityType: 'user',
      entityId: user.id,
      actorUserId: user.id,
      actorRole: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /**
   * Смена пароля по ссылке из письма.
   *
   * Закрываются **все** сессии, включая текущую: пароль восстанавливают, когда доступ
   * потерян, и оставить живой чужую сессию значит не сделать ничего.
   */
  async confirmPasswordReset(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const now = new Date();
    const found = await this.repository.findLiveAuthToken(hashToken(token), 'password_reset', now);
    // Просроченный, использованный и выдуманный токен отвечают одинаково: разница
    // сообщала бы, что такой токен когда-то существовал.
    if (found === undefined) throw unauthenticated('Ссылка недействительна или устарела');

    const used = await this.repository.useAuthToken(found.token.id, now);
    // Два одновременных перехода по одной ссылке: второй проиграл гонку и получает
    // тот же ответ, что и по недействительной ссылке.
    if (!used) throw unauthenticated('Ссылка недействительна или устарела');

    await this.repository.setPasswordHash(found.user.id, await hashPassword(newPassword));
    const revoked = await this.repository.revokeAllSessions(found.user.id, now);

    await this.audit.record({
      action: 'user.password_reset',
      entityType: 'user',
      entityId: found.user.id,
      actorUserId: found.user.id,
      actorRole: found.user.role,
      after: { revoked_sessions: revoked },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /**
   * Подтверждение адреса.
   *
   * Ставит отметку и **не** открывает доступ: партнёра допускает администратор,
   * и связать это с почтой значило бы пустить в систему любого, у кого есть ящик.
   */
  async confirmEmail(token: string, meta: RequestMeta): Promise<void> {
    const now = new Date();
    const found = await this.repository.findLiveAuthToken(
      hashToken(token),
      'email_verification',
      now,
    );
    if (found === undefined) throw unauthenticated('Ссылка недействительна или устарела');
    if (!(await this.repository.useAuthToken(found.token.id, now))) {
      throw unauthenticated('Ссылка недействительна или устарела');
    }

    await this.repository.setEmailConfirmed(found.user.id, now);
    await this.audit.record({
      action: 'user.email_confirmed',
      entityType: 'user',
      entityId: found.user.id,
      actorUserId: found.user.id,
      actorRole: found.user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /**
   * Повторное письмо с подтверждением — тому, кто уже вошёл.
   *
   * Единственный путь отправки, где отказ по частоте сообщается честно: сюда приходят
   * с действующей сессией, скрывать нечего, а молчание человек прочтёт как «письмо ушло».
   */
  async resendEmailVerification(principal: Principal): Promise<void> {
    const user = await this.repository.findById(principal.userId);
    if (user === undefined) throw notFound('Пользователь не найден');
    if (user.emailConfirmedAt !== null) throw conflict('Адрес уже подтверждён');

    await this.assertWithinRate(EMAIL_RESEND_RULE, principal.userId);

    const now = new Date();
    if (!(await this.sendEmailVerification(user, now))) {
      const quota = await this.mail.canSendTo(user.email, now);
      throw tooManyAttempts(quota.retryAfterSeconds);
    }
  }

  /**
   * Заводит токен подтверждения и письмо о нём — одной транзакцией.
   *
   * Отдельным методом, потому что вызывается и при регистрации, и повторно по просьбе
   * человека: два места, где это делается по-разному, разъедутся на первой же правке.
   */
  private async sendEmailVerification(user: UserRow, now: Date): Promise<boolean> {
    const issued = issueToken(now, EMAIL_VERIFICATION_TTL_HOURS * 3_600_000);
    const letter = emailVerificationLetter(
      this.config.WEB_BASE_URL,
      issued.token,
      EMAIL_VERIFICATION_TTL_HOURS,
    );

    return this.repository.db.transaction(async (tx) => {
      // До записи токена: иначе исчерпанный предел гасил бы действующую ссылку впустую
      // ([ADR-0030](../../../../../docs/adr/0030-predel-pisem-na-adres.md)).
      if (!(await this.mail.canSendTo(user.email, now, tx)).allowed) return false;

      await this.repository.expireAuthTokens(user.id, 'email_verification', now, tx);
      await this.repository.createAuthToken(
        {
          userId: user.id,
          purpose: 'email_verification',
          tokenHash: issued.tokenHash,
          expiresAt: issued.expiresAt,
        },
        tx,
      );
      return this.mail.enqueue({ recipient: user.email, ...letter }, tx);
    });
  }

  /** Убирает просроченные одноразовые токены: смысла в них нет, а строки копятся. */
  async purgeExpiredAuthTokens(now: Date = new Date()): Promise<number> {
    return this.repository.deleteExpiredAuthTokens(now, SESSION_SWEEP_LIMIT);
  }

  // --- Пароль и второй фактор ------------------------------------------------------

  /**
   * Смена пароля из кабинета.
   *
   * Текущий пароль спрашивается обязательно: украденная сессия иначе превращается
   * в украденную учётную запись одним запросом.
   *
   * Прочие сессии закрываются, текущая остаётся: пароль меняют, когда подозревают,
   * что им завладели, и оставить чужую сессию живой значит не сделать ничего. А выкинуть
   * человека из устройства, за которым он только что сменил пароль, — способ научить
   * его пароли не менять.
   */
  async changePassword(
    principal: Principal,
    input: { currentPassword: string; newPassword: string },
    meta: RequestMeta,
  ): Promise<{ revokedSessions: number }> {
    const user = await this.repository.findById(principal.userId);
    if (user === undefined) throw notFound('Пользователь не найден');

    await this.assertWithinFailureRate(PASSWORD_CHANGE_RULE, principal.userId);
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      await this.countFailure(PASSWORD_CHANGE_RULE, principal.userId);
      throw unauthenticated('Неверный текущий пароль');
    }
    await this.forgetFailures(PASSWORD_CHANGE_RULE, principal.userId);

    await this.repository.setPasswordHash(user.id, await hashPassword(input.newPassword));
    const revoked = await this.repository.revokeAllSessions(user.id, new Date(), {
      keepSessionId: principal.sessionId,
    });

    await this.audit.record({
      action: 'user.password_changed',
      entityType: 'user',
      entityId: user.id,
      actorUserId: user.id,
      actorRole: user.role,
      after: { revoked_sessions: revoked },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { revokedSessions: revoked };
  }

  /**
   * Начинает подключение второго фактора: выдаёт секрет и ссылку для аутентификатора.
   *
   * До подтверждения кодом фактор не действует — иначе человек запер бы себя, не проверив,
   * что аутентификатор показывает верные коды. Повторный вызов заменяет неподтверждённый
   * секрет новым: так выглядит «начал, бросил, начал заново».
   */
  async startTotpEnrolment(principal: Principal): Promise<{ secret: string; uri: string }> {
    const user = await this.repository.findById(principal.userId);
    if (user === undefined) throw notFound('Пользователь не найден');
    if (user.totpConfirmedAt !== null) {
      throw conflict('Второй фактор уже подключён: сначала отключите его');
    }

    const secret = generateTotpSecret();
    await this.repository.setTotpSecret(user.id, encryptSecret(secret, this.config.SECRET_KEY));

    // Секрет уходит в ответ ровно один раз и в журнал не попадает: в журнале он был бы
    // вторым фактором, лежащим рядом с записью о том, чей он.
    return { secret, uri: otpauthUri(secret, user.email, TOTP_ISSUER) };
  }

  /** Подтверждает подключение кодом: без этого второй фактор не включается. */
  async confirmTotp(principal: Principal, code: string, meta: RequestMeta): Promise<void> {
    const user = await this.repository.findById(principal.userId);
    if (user === undefined) throw notFound('Пользователь не найден');
    if (user.totpSecret === null) throw conflict('Подключение второго фактора не начато');
    if (user.totpConfirmedAt !== null) throw conflict('Второй фактор уже подключён');

    const now = new Date();
    const step = verifyTotp(this.readTotpSecret(user), code, now);
    if (step === undefined) throw validationFailed('Код не подходит');

    await this.repository.confirmTotp(user.id, now, step);
    await this.audit.record({
      action: 'user.totp_enabled',
      entityType: 'user',
      entityId: user.id,
      actorUserId: user.id,
      actorRole: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /**
   * Отключение второго фактора самим человеком.
   *
   * Спрашивается и пароль, и код: отключение — это снятие защиты, и одной украденной
   * сессии для него быть недостаточно.
   */
  async disableTotp(
    principal: Principal,
    input: { password: string; code: string },
    meta: RequestMeta,
  ): Promise<void> {
    const user = await this.repository.findById(principal.userId);
    if (user === undefined) throw notFound('Пользователь не найден');
    if (user.totpSecret === null || user.totpConfirmedAt === null) {
      throw conflict('Второй фактор не подключён');
    }

    if (!(await verifyPassword(input.password, user.passwordHash))) {
      throw unauthenticated('Неверный пароль');
    }
    const step = verifyTotp(this.readTotpSecret(user), input.code, new Date(), {
      ...(user.totpLastStep === null ? {} : { minStep: user.totpLastStep }),
    });
    if (step === undefined) throw validationFailed('Код не подходит');

    await this.repository.setTotpSecret(user.id, null);
    await this.audit.record({
      action: 'user.totp_disabled',
      entityType: 'user',
      entityId: user.id,
      actorUserId: user.id,
      actorRole: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /**
   * Сброс второго фактора администратором — путь назад при потерянном телефоне.
   *
   * Кодов восстановления нет намеренно: это ещё один секрет, который люди хранят
   * в заметках рядом с паролем (ADR-0028). Здесь путь назад — человек, и его действие
   * остаётся в журнале.
   */
  async resetTotp(id: UserId, actorUserId: UserId, actorRole: UserRole): Promise<void> {
    const user = await this.repository.findById(id);
    if (user === undefined) throw notFound('Пользователь не найден');

    await this.repository.setTotpSecret(id, null);
    await this.audit.record({
      action: 'user.totp_reset',
      entityType: 'user',
      entityId: id,
      actorUserId,
      actorRole,
      before: { totp_enabled: user.totpConfirmedAt !== null },
    });
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
