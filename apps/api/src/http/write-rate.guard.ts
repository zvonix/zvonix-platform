/**
 * Предел частоты обращений: изменяющих — у людей
 * ([ADR-0041](../../../../docs/adr/0041-predel-chastoty-izmeneniy.md)), любых —
 * у клиентского ключа ([ADR-0044](../../../../docs/adr/0044-klientskiy-api.md)).
 *
 * Второй глобальный защитник, и порядок с первым важен: считать можно только того,
 * кто уже опознан, поэтому этот идёт **после** `AuthGuard` — он и берёт учётную запись
 * из запроса, который тот заполнил.
 *
 * Два правила, а не два защитника: вопрос «сколько обращений в минуту» один, и разносить
 * ответ на него по разным местам значит однажды поменять одно и забыть другое.
 *
 * Не путать с доменными лимитами клиента и SIM ([ADR-0026](../../../../docs/adr/0026-limity-po-oknam.md)):
 * те про деньги и ёмкость, считаются в PostgreSQL и отказ по ним — часть предметной
 * области. Здесь про объём обращений, счёт в Redis, и потеря счётчика допустима.
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { rateLimited } from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../infra/tokens.js';
import { RateLimitService, type LimitRule } from '../modules/limits/rate-limit.service.js';
import { MACHINE_KEY, PUBLIC_KEY, UNMETERED_KEY, type AuthenticatedRequest } from './auth.guard.js';
import { isSafeMethod } from './session-cookie.js';

@Injectable()
export class WriteRateGuard implements CanActivate {
  private readonly rule: LimitRule | undefined;
  private readonly clientApiRule: LimitRule | undefined;
  private readonly logger: Logger;

  constructor(
    private readonly reflector: Reflector,
    private readonly limits: RateLimitService,
    @Inject(APP_CONFIG) config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('limits');
    const limit = config.WRITE_RATE_LIMIT_PER_MINUTE;
    this.rule = limit === 0 ? undefined : { name: 'write', limit, windowSeconds: 60 };

    const clientApiLimit = config.CLIENT_API_RATE_LIMIT_PER_MINUTE;
    this.clientApiRule =
      clientApiLimit === 0
        ? undefined
        : { name: 'client-api', limit: clientApiLimit, windowSeconds: 60 };

    // Снятый предел обязан быть заметен: узнать о нём из переменной окружения
    // через полгода — не то же самое, что увидеть в журнале при запуске.
    if (this.rule === undefined) {
      this.announceRemoved(
        config,
        'Предел частоты изменений снят: изменяющие обращения не ограничены',
        'WRITE_RATE_LIMIT_PER_MINUTE',
      );
    }
    if (this.clientApiRule === undefined) {
      this.announceRemoved(
        config,
        'Предел клиентского API снят: обращения по ключу не ограничены',
        'CLIENT_API_RATE_LIMIT_PER_MINUTE',
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // Клиентский ключ считается первым и целиком, включая чтения: в этом контуре опрос
    // и есть основная нагрузка (ADR-0044). Счёт по ключу, а не по клиенту, — у клиента
    // их несколько, и сорвавшаяся одна система не должна останавливать остальные.
    const machine = request.machine;
    if (machine?.kind === 'client_api') {
      if (this.clientApiRule === undefined) return true;
      const verdict = await this.limits.hit(this.clientApiRule, machine.keyId);
      if (!verdict.allowed) {
        throw rateLimited('Слишком много обращений за минуту', {
          details: { key_id: machine.keyId, retry_after_seconds: verdict.retryAfterSeconds },
        });
      }
      return true;
    }

    if (this.rule === undefined) return true;
    if (isSafeMethod(request.method)) return true;

    // Публичные обработчики несут собственные пределы под свою угрозу — перебор пароля
    // считается по адресу, а не по учётной записи, которой там ещё нет. Общий счётчик
    // поверх них оказался бы мягче и создал впечатление, что защита есть.
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets) === true) {
      return true;
    }

    // Машинный контур: объём узла — это телефония. Человеческий предел означал бы
    // несостоявшиеся звонки, а злоупотребление ключом лечится его отзывом (ADR-0019).
    if (this.reflector.getAllAndOverride(MACHINE_KEY, targets) !== undefined) return true;

    // Дверь наружу не запирается пределом объёма: выход и закрытие сессий обязаны
    // работать именно тогда, когда счётчик исчерпан, — в том числе чужими руками.
    if (this.reflector.getAllAndOverride<boolean | undefined>(UNMETERED_KEY, targets) === true) {
      return true;
    }

    const userId = request.principal?.userId;
    // Учётной записи нет — считать нечего. Такое обращение до обработчика не дойдёт:
    // `AuthGuard` уже отказал бы. Проверка здесь на случай, если порядок защитников
    // однажды поменяют местами: тихо перестать считать хуже, чем не считать явно.
    if (userId === undefined) return true;

    const verdict = await this.limits.hit(this.rule, userId);
    if (!verdict.allowed) {
      throw rateLimited('Слишком много изменений за минуту', {
        details: { retry_after_seconds: verdict.retryAfterSeconds },
      });
    }

    return true;
  }

  private announceRemoved(config: Config, message: string, variable: string): void {
    const fields = { variable, env: config.APP_ENV };
    if (config.APP_ENV === 'production') this.logger.error(message, undefined, fields);
    else this.logger.warn(message, fields);
  }
}
