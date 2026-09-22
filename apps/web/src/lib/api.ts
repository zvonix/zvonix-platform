/**
 * Единственная дверь кабинета в API.
 *
 * Здесь, и только здесь, ставится заголовок `X-Zvonix-Web`, без которого изменяющий
 * запрос по cookie не принимается ([ADR-0037](../../../../docs/adr/0037-sessiya-v-brauzere.md)).
 * Запрос в обход этого клиента получит `403`, и это правильно: забыть заголовок
 * в одном месте лучше, чем забыть его в двадцати.
 *
 * Токена здесь нет и быть не может — сессия живёт в cookie с `HttpOnly`, недоступной
 * сценарию. Браузер отправляет её сам, потому что кабинет и API видны по одному адресу.
 */

import type { ErrorCode } from '@zvonix/shared';

/** Общий для всей платформы префикс: обратный прокси отдаёт его в API. */
const BASE = '/api';

/**
 * Сколько кабинет ждёт ответа — целиком, вместе с телом.
 *
 * Без предела зависший запрос держал кабинет пустой заглушкой, а окно подтверждения —
 * запертым, до закрытия вкладки. 20 с — дольше любого штатного ответа: запрос к базе
 * API ограничен 15 с. Кому нужно дольше — тому, что само ходит наружу, — задаёт
 * `timeoutMs` явно.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Ответ об отказе в виде из ADR-0003. Разбирается один раз, здесь. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details: Readonly<Record<string, unknown>>,
    readonly correlationId: string | undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Сессии нет или она больше не годится: кабинету пора на страницу входа. */
  get needsLogin(): boolean {
    return this.code === 'unauthenticated';
  }

  /**
   * Ответа не дождались. Для изменения это не «не выполнено», а «неизвестно»:
   * запрос мог дойти и выполниться.
   */
  get timedOut(): boolean {
    return this.status === 0 && typeof this.details['timeout_ms'] === 'number';
  }

  /**
   * Разбор входа по полям — то, что безопасно показать человеку (ADR-0003).
   * Значений полей там нет: в теле запроса лежат пароли.
   */
  get problems(): string[] {
    const value = this.details['problems'];
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  }
}

interface ErrorEnvelope {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: Record<string, unknown>;
    readonly correlation_id?: string;
  };
}

const ERROR_CODES: readonly string[] = [
  'validation_failed',
  'unauthenticated',
  'permission_denied',
  'not_found',
  'conflict',
  'rate_limited',
  'dependency_unavailable',
  'internal',
];

function codeOf(value: unknown, status: number): ErrorCode {
  if (typeof value === 'string' && ERROR_CODES.includes(value)) return value as ErrorCode;
  return status === 401 ? 'unauthenticated' : 'internal';
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  readonly method?: Method;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Предел ожидания ответа вместе с телом, мс. По умолчанию — 20 с. */
  readonly timeoutMs?: number;
}

/**
 * Ответа не дождались.
 *
 * Код прежний — `dependency_unavailable`: набор кодов — контракт ADR-0003. Признак
 * тайм-аута — `details.timeout_ms` и статус `0`. Чтение просто стоит повторить позже.
 * У изменения исход неизвестен, и повтор вслепую мог бы выполнить действие дважды.
 */
function timeoutError(method: Method, timeoutMs: number): ApiError {
  const seconds = String(Math.round(timeoutMs / 1000));
  const message =
    method === 'GET'
      ? `Платформа не ответила за ${seconds} с — повторите позже`
      : `Платформа не ответила за ${seconds} с. Действие могло выполниться — проверьте результат, прежде чем повторять`;
  return new ApiError('dependency_unavailable', message, 0, { timeout_ms: timeoutMs }, undefined);
}

/**
 * Запрос к API.
 *
 * Разбирает ответ об отказе в `ApiError`: вызывающий не должен помнить, что у нас
 * ошибка приходит телом, а не текстом. Недоступность сети — тоже `ApiError`,
 * но с кодом `dependency_unavailable`: экрану всё равно, чем именно не ответили.
 * Отмена вызывающим (`signal`) пробрасывается как есть: это не ошибка, а решение.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = { 'X-Zvonix-Web': '1' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const external = options.signal;
  external?.throwIfAborted();

  // Свой контроллер вместо `AbortSignal.any`: того нет в Safari до 17.4, а кабинет
  // открывают и с телефона. Внешняя отмена пересылается в тот же контроллер.
  const controller = new AbortController();
  // Флаг в объекте: поток управления не видит присваивания из таймера.
  const deadline = { expired: false };
  const timer = setTimeout(() => {
    deadline.expired = true;
    controller.abort();
  }, timeoutMs);
  const forward = (): void => {
    controller.abort(external?.reason);
  };
  external?.addEventListener('abort', forward, { once: true });

  try {
    let response: Response;
    try {
      response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        // Cookie отправляется браузером самостоятельно, но умолчание `fetch` зависит
        // от того, как вызвали; здесь оно задано явно, чтобы не зависеть от версии.
        credentials: 'same-origin',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
    } catch (cause) {
      if (deadline.expired) throw timeoutError(method, timeoutMs);
      if (external?.aborted === true) throw cause;
      throw new ApiError('dependency_unavailable', 'Платформа не отвечает', 0, {}, undefined);
    }

    if (response.status === 204) return undefined as T;

    // Тело читается под тем же пределом. Отмена посреди тела — это тайм-аут или отмена,
    // а не «успех без тела», каким она выглядела, пока ошибка чтения глоталась целиком.
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      if (deadline.expired) throw timeoutError(method, timeoutMs);
      if (external?.aborted === true) throw cause;
      // Не JSON — ответил прокси своей страницей. Разбирается ниже по статусу.
      payload = undefined;
    }

    if (!response.ok) {
      const envelope = (payload ?? {}) as ErrorEnvelope;
      throw new ApiError(
        codeOf(envelope.error?.code, response.status),
        envelope.error?.message ?? 'Запрос не выполнен',
        response.status,
        envelope.error?.details ?? {},
        envelope.error?.correlation_id,
      );
    }

    return payload as T;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', forward);
  }
}
