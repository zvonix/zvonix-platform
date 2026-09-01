/**
 * Доменные ошибки (ADR-0003).
 *
 * Домен не знает о транспорте: здесь нет ни HTTP-кодов, ни ответов API.
 * Отображение кода ошибки в ответ выполняется на границе транспорта, в одном месте.
 *
 * Разделение полей принципиально:
 *   `details` — безопасно отдавать наружу (какое поле не прошло валидацию);
 *   `cause`   — внутренняя причина, наружу не уходит никогда.
 */

/** Стабильные коды ошибок. Расширяются, но не переименовываются. */
export const ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'permission_denied',
  'not_found',
  'conflict',
  'rate_limited',
  'dependency_unavailable',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Структурированные подробности, которые безопасно показать вызывающей стороне. */
export type ErrorDetails = Readonly<Record<string, string | number | boolean | readonly string[]>>;

export interface DomainErrorOptions {
  /** Безопасные для внешнего мира подробности. Секретов и персональных данных здесь быть не должно. */
  readonly details?: ErrorDetails;
  /** Исходная ошибка. Хранится для диагностики и наружу не отдаётся. */
  readonly cause?: unknown;
}

/**
 * Базовая доменная ошибка.
 *
 * Создаётся не напрямую, а через функции ниже: они задают код и делают его
 * различимым для проверки типа.
 */
export class DomainError extends Error {
  override readonly name: string = 'DomainError';
  readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options.details;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

/** Ввод не прошёл валидацию. */
export function validationFailed(message: string, options?: DomainErrorOptions): DomainError {
  return new DomainError('validation_failed', message, options);
}

/** Вызывающая сторона не опознана. */
export function unauthenticated(message: string, options?: DomainErrorOptions): DomainError {
  return new DomainError('unauthenticated', message, options);
}

/** Опознана, но действие не разрешено. */
export function permissionDenied(message: string, options?: DomainErrorOptions): DomainError {
  return new DomainError('permission_denied', message, options);
}

/** Объект не существует. */
export function notFound(message: string, options?: DomainErrorOptions): DomainError {
  return new DomainError('not_found', message, options);
}

/** Конфликт состояния или нарушение инварианта. */
export function conflict(message: string, options?: DomainErrorOptions): DomainError {
  return new DomainError('conflict', message, options);
}

/** Превышен лимит. */
export function rateLimited(message: string, options?: DomainErrorOptions): DomainError {
  return new DomainError('rate_limited', message, options);
}

/**
 * Внешняя зависимость недоступна.
 *
 * Ошибки внешних систем оборачиваются в эту, а не пробрасываются: иначе наружу
 * утекают детали чужой реализации, а домен начинает зависеть от их формата.
 */
export function dependencyUnavailable(message: string, options?: DomainErrorOptions): DomainError {
  return new DomainError('dependency_unavailable', message, options);
}

/** Всё остальное. Наружу подробности такой ошибки не отдаются. */
export function internal(message: string, options?: DomainErrorOptions): DomainError {
  return new DomainError('internal', message, options);
}

/**
 * Приводит произвольное значение из `catch` к доменной ошибке.
 *
 * Нужна на границах, где ловится что угодно: доменная ошибка проходит насквозь,
 * всё остальное оборачивается в `internal` с сохранением причины. Проглатывание
 * исключений запрещено (ADR-0003), поэтому функция всегда возвращает ошибку,
 * а не `undefined`.
 */
export function toDomainError(value: unknown, fallbackMessage = 'Внутренняя ошибка'): DomainError {
  if (isDomainError(value)) return value;
  return internal(fallbackMessage, { cause: value });
}

/**
 * Представление ошибки, безопасное для передачи наружу.
 * Ни `cause`, ни стек, ни внутреннее сообщение сюда не попадают.
 */
export interface PublicErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: ErrorDetails;
}

/**
 * Готовит ошибку к отдаче вызывающей стороне.
 *
 * Для `internal` сообщение заменяется на обобщённое: текст внутренней ошибки может
 * содержать пути, запросы и имена систем, и наружу ему нельзя.
 */
export function toPublicPayload(error: DomainError): PublicErrorPayload {
  if (error.code === 'internal') {
    return { code: 'internal', message: 'Внутренняя ошибка' };
  }
  return error.details === undefined
    ? { code: error.code, message: error.message }
    : { code: error.code, message: error.message, details: error.details };
}
