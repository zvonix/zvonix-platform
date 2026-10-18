/**
 * Что сломалось на самой площадке: письма не уходят, фоновый воркер молчит, сообщения MAX массово не отправляются
 * ([ADR-0062](../../../../../docs/adr/0062-trevogi-administratoram.md), ревизия 2026-10-18).
 *
 * Показывается в кабинете (красная точка в меню, строка в «Обзоре»), а не письмом: о сломанной почте и мёртвом воркере
 * письмом не сообщить. Состояние читается каждый раз заново, ничего не запоминается — как и остальные условия тревог.
 */

import { Inject, Injectable } from '@nestjs/common';
import { isRedisReady, RedisService } from '../../infra/redis.js';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { MailService } from '../mail/mail.service.js';
import { MessagesService } from '../messaging/messages.service.js';
import { readProviderOutage } from '../messaging/provider-outage.js';

/** Ключ в Redis: когда воркер в последний раз подал признак жизни. */
export const WORKER_HEARTBEAT_KEY = 'zvonix:worker:heartbeat';

/** Воркер отмечается раз в минуту; трёх пропущенных отметок подряд достаточно, чтобы считать его остановившимся. */
const WORKER_SILENT_MS = 3 * 60_000;

/** Письмо, которое ждёт доставки дольше этого, — не очередь, а поломка (воркер раз в 30 секунд берёт всё готовое). */
const MAIL_STUCK_MS = 10 * 60_000;

/** За час принято не меньше стольких сообщений и не отправлено больше половины — отправка сломана (как в тревоге по почте). */
const MESSAGES_ENOUGH = 10;

const HOUR_MS = 3_600_000;

/** Сбой провайдера старше этого уже ничего не говорит о нынешнем состоянии: с тех пор никто к нему не обращался. */
const PROVIDER_OUTAGE_FRESH_MS = 30 * 60_000;

export interface PlatformProblem {
  /** Что именно: «Почта», «Фоновый воркер», «Сообщения MAX». */
  readonly name: string;
  /** Человеческое описание и что делать. */
  readonly reason: string;
}

@Injectable()
export class PlatformHealthService {
  private readonly logger: Logger;

  constructor(
    private readonly redis: RedisService,
    private readonly mail: MailService,
    private readonly messages: MessagesService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('platform-health');
  }

  /** Отметка воркера; вызывается его задачей раз в минуту. Возвращает 1, если записано. */
  async recordWorkerHeartbeat(now: Date): Promise<number> {
    await this.redis.connection.set(WORKER_HEARTBEAT_KEY, now.toISOString());
    return 1;
  }

  /** Что сейчас не в порядке. Сбой чтения одного источника не гасит остальные. */
  async problems(now: Date = new Date()): Promise<PlatformProblem[]> {
    const found: PlatformProblem[] = [];
    const sources = [
      ['воркер', () => this.workerProblem(now)],
      ['почта', () => this.mailProblem(now)],
      ['сообщения', () => this.messageProblem(now)],
      ['провайдер', () => this.providerProblem(now)],
    ] as const;
    for (const [source, read] of sources) {
      try {
        const problem = await read();
        if (problem !== undefined) found.push(problem);
      } catch (cause) {
        this.logger.error('Состояние площадки не прочитано', cause, { source });
      }
    }
    return found;
  }

  private async workerProblem(now: Date): Promise<PlatformProblem | undefined> {
    if (!isRedisReady(this.redis.connection)) {
      return { name: 'Redis', reason: 'недоступен: очереди и пределы не работают' };
    }
    const stamp = await this.redis.connection.get(WORKER_HEARTBEAT_KEY);
    const at = stamp === null ? Number.NaN : Date.parse(stamp);
    if (Number.isNaN(at) || now.getTime() - at > WORKER_SILENT_MS) {
      return {
        name: 'Фоновый воркер',
        reason:
          'не отвечает: письма, рассылка сообщений и расчёты стоят. Перезапустите службу zvonix-worker',
      };
    }
    return undefined;
  }

  private async mailProblem(now: Date): Promise<PlatformProblem | undefined> {
    const queue = await this.mail.queueOverview();
    if (queue.oldest_pending_at === null) return undefined;
    if (now.getTime() - Date.parse(queue.oldest_pending_at) < MAIL_STUCK_MS) return undefined;
    if (!queue.configured) {
      return {
        name: 'Почта',
        reason:
          'не настроена: письма входа и восстановления не уходят. Заполните «Настройки площадки» → «Почта и письма»',
      };
    }
    const error = queue.recent.find((item) => item.last_error !== null)?.last_error;
    const detail = error === undefined || error === null ? '' : `: ${error.slice(0, 160)}`;
    return {
      name: 'Почта',
      reason: `письма не уходят (ждут ${String(queue.pending)})${detail}. Откройте «Настройки площадки» → «Почта и письма»`,
    };
  }

  /**
   * Провайдер сообщений не отвечает: последнее обращение к нему (вход по QR, отправка, проверка) кончилось таймаутом,
   * обрывом или ответом 5xx и ни одно из следующих не удалось. Успешный ответ снимает запись.
   */
  private async providerProblem(now: Date): Promise<PlatformProblem | undefined> {
    const outage = await readProviderOutage(this.redis);
    if (outage === undefined || now.getTime() - outage.at.getTime() > PROVIDER_OUTAGE_FRESH_MS) {
      return undefined;
    }
    const how =
      outage.reason === 'timeout'
        ? 'не отвечает вовремя'
        : outage.reason === 'server'
          ? `отвечает ошибкой ${String(outage.status ?? 'сервера')}`
          : 'недоступен из сети';
    return {
      name: 'Сервис сообщений',
      reason: `${how} (последний сбой ${outage.at.toISOString().slice(11, 16)} UTC): вход аккаунтов по QR и отправка могут не работать. Проверьте «Настройки площадки» → «Сообщения» → «Проверить ключ»`,
    };
  }

  private async messageProblem(now: Date): Promise<PlatformProblem | undefined> {
    const health = await this.messages.health(new Date(now.getTime() - HOUR_MS));
    if (health.total < MESSAGES_ENOUGH || health.failed * 2 < health.total) return undefined;
    return {
      name: 'Сообщения MAX',
      reason: `за час не отправлено ${String(health.failed)} из ${String(health.total)}: аккаунты вышли из MAX или сбой у провайдера. Откройте «Сообщения MAX»`,
    };
  }
}
