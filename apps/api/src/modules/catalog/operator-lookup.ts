/**
 * Внешний сервис определения оператора номера (ADR-0013).
 *
 * Отделён интерфейсом от резолвера намеренно: источник заменяется без переписывания
 * системы. Сегодня это бесплатный NUM API «Вокс Линк», завтра — платный поставщик,
 * настроенный запасным с первого дня. Код маршрутизации и тарификации не должен знать,
 * откуда пришёл ответ.
 */

import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { maskPhone } from '@zvonix/logger';
import type { Msisdn } from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';

/** Ответ внешнего сервиса. Названия операторов — как их вернул источник, без приведения. */
export interface LookupAnswer {
  readonly operatorName: string;
  /** Прежний оператор, если номер переносился. Источник сообщает его не всегда. */
  readonly previousOperatorName: string | undefined;
  readonly region: string | undefined;
}

export interface OperatorLookup {
  /** `undefined` — источник номера не знает либо оказался недоступен. */
  lookup(msisdn: Msisdn): Promise<LookupAnswer | undefined>;
  /** Выключенный источник в сеть не ходит вовсе и всегда отвечает `undefined`. */
  readonly enabled: boolean;
}

/**
 * Токен внедрения источника.
 *
 * Резолвер зависит от него, а не от конкретной реализации: смена поставщика —
 * замена одного провайдера в модуле, а не правка кода определения оператора.
 * Платный поставщик подключается сюда же, оставаясь настроенным запасным.
 */
export const OPERATOR_LOOKUP = Symbol('OPERATOR_LOOKUP');

/**
 * Жёсткий предел на запрос.
 *
 * Определение оператора выполняется в цепочке обработки вызова: пока мы ждём ответа,
 * абонент слушает тишину. Лучше отказать быстро и поставить номер в очередь
 * на разрешение, чем задержать вызов на несколько секунд.
 */
const REQUEST_TIMEOUT_MS = 3000;

/**
 * Очередь с минимальным интервалом между запросами.
 *
 * Лимит источника — десять запросов в секунду на адрес, и подходить к нему вплотную
 * нельзя: ровные десять запросов в секунду с одного адреса не похожи ни на что, кроме
 * перебора, и мы потеряем ровно тот бесплатный ресурс, на котором держится определение.
 */
class RequestPacer {
  private readonly minIntervalMs: number;
  private next = Promise.resolve();
  private lastStartedAt = 0;

  constructor(requestsPerSecond: number) {
    this.minIntervalMs = Math.ceil(1000 / requestsPerSecond);
  }

  /** Пропускает работу не чаще заданного темпа, сохраняя порядок вызовов. */
  schedule<T>(work: () => Promise<T>): Promise<T> {
    const scheduled = this.next.then(async () => {
      const wait = this.lastStartedAt + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastStartedAt = Date.now();
      return work();
    });

    // Очередь не должна обрываться из-за неудачи одного запроса.
    this.next = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }
}

/** Ответ NUM API: три необязательных строки. Пустой `operator` означает «не знаю». */
interface VoxlinkResponse {
  readonly operator?: unknown;
  readonly old_operator?: unknown;
  readonly region?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

@Injectable()
export class VoxlinkOperatorLookup implements OperatorLookup, OnApplicationShutdown {
  readonly enabled: boolean;
  private readonly url: string;
  private readonly pacer: RequestPacer;
  private readonly logger: Logger;
  private readonly abort = new AbortController();

  /** Подряд идущие неудачи. Рост означает, что источник сломался или нас закрыли. */
  private consecutiveFailures = 0;

  constructor(@Inject(APP_CONFIG) config: Config, @Inject(APP_LOGGER) logger: Logger) {
    this.enabled = config.OPERATOR_LOOKUP_ENABLED;
    this.url = config.OPERATOR_LOOKUP_URL;
    this.pacer = new RequestPacer(config.OPERATOR_LOOKUP_RPS);
    this.logger = logger.child('operator-lookup');
  }

  async lookup(msisdn: Msisdn): Promise<LookupAnswer | undefined> {
    if (!this.enabled) return undefined;
    return this.pacer.schedule(() => this.request(msisdn));
  }

  private async request(msisdn: Msisdn): Promise<LookupAnswer | undefined> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout, this.abort.signal]);

    try {
      const response = await fetch(`${this.url}?num=${msisdn}`, {
        signal,
        headers: { accept: 'application/json' },
      });

      if (!response.ok) {
        this.registerFailure(`HTTP ${String(response.status)}`, msisdn);
        return undefined;
      }

      const body = (await response.json()) as VoxlinkResponse;
      const operatorName = text(body.operator);
      if (operatorName === undefined) {
        // Источник ответил, но номера не знает. Это не сбой: неудачи не считаем.
        this.consecutiveFailures = 0;
        return undefined;
      }

      this.consecutiveFailures = 0;
      return {
        operatorName,
        previousOperatorName: text(body.old_operator),
        region: text(body.region),
      };
    } catch (cause) {
      // Недоступность внешнего сервиса — штатное состояние, а не авария приложения:
      // резолвер обязан продолжить работу и вернуть «оператор не подтверждён».
      this.registerFailure(String(cause), msisdn);
      return undefined;
    }
  }

  /**
   * Считает неудачи подряд и предупреждает при их росте.
   *
   * Без этого исчезновение источника выглядит как тихая деградация: вызовы просто
   * начинают отклоняться «оператор не подтверждён», и понять почему — некому.
   */
  private registerFailure(reason: string, msisdn: Msisdn): void {
    this.consecutiveFailures += 1;
    const fields = {
      reason,
      // Номер в логе маскируется: он персональные данные.
      msisdn: maskPhone(msisdn),
      consecutive_failures: this.consecutiveFailures,
    };

    if (this.consecutiveFailures >= 10) {
      this.logger.error('Источник определения оператора недоступен подряд', undefined, fields);
    } else {
      this.logger.warn('Запрос к источнику определения оператора не удался', fields);
    }
  }

  onApplicationShutdown(): void {
    // Иначе висящий запрос удерживает процесс после SIGTERM.
    this.abort.abort();
  }
}
