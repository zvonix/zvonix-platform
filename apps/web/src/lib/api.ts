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

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * Запрос к API.
 *
 * Разбирает ответ об отказе в `ApiError`: вызывающий не должен помнить, что у нас
 * ошибка приходит телом, а не текстом. Недоступность сети — тоже `ApiError`,
 * но с кодом `dependency_unavailable`: экрану всё равно, чем именно не ответили.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { 'X-Zvonix-Web': '1' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      // Cookie отправляется браузером самостоятельно, но умолчание `fetch` зависит
      // от того, как вызвали; здесь оно задано явно, чтобы не зависеть от версии.
      credentials: 'same-origin',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError('dependency_unavailable', 'Платформа не отвечает', 0, {}, undefined);
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => undefined);

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
}
