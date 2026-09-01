/**
 * Маскирование чувствительных данных в логах (ADR-0004).
 *
 * Принципиально: маскирует **логгер**, а не автор вызова. Полагаться на то, что
 * каждый разработчик вспомнит про секрет в каждой точке логирования, нельзя —
 * достаточно одного пропуска, чтобы пароль или номер абонента ушли в хранилище логов.
 */

const HIDDEN = '<скрыто>';

/** Имена полей, значения которых не логируются никогда, независимо от содержимого. */
const SENSITIVE_KEY =
  /(pass|secret|token|apikey|api_key|authorization|cookie|credential|private_key|dsn|database_url)/i;

/**
 * Телефонные номера — персональные данные. Ловим и российские, и произвольные
 * последовательности из 10–15 цифр с типичными разделителями.
 */
const PHONE = /(?:\+?\d[\s\-()]?){10,15}\d/g;

/** Глубина обхода: защита от самоссылающихся структур и случайно залогированного дерева. */
const MAX_DEPTH = 6;

/**
 * Маскирует номер, сохраняя достаточно для диагностики: код страны с кодом оператора
 * и две последние цифры. По такому виду вызов в логах узнаётся, а абонент — нет.
 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10) return value;
  return digits.slice(0, 4) + '*'.repeat(Math.max(0, digits.length - 6)) + digits.slice(-2);
}

function maskPhonesInText(value: string): string {
  return value.replace(PHONE, (match) => maskPhone(match));
}

/**
 * Рекурсивно готовит значение к записи в лог.
 *
 * Ошибки разворачиваются вместе со стеком и причиной: это внутренний лог,
 * и диагностика здесь важнее лаконичности. Наружу такие данные не уходят —
 * за это отвечает `toPublicPayload` в доменных ошибках.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return maskPhonesInText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '<функция>';
  if (typeof value === 'symbol') return value.toString();

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskPhonesInText(value.message),
      stack: value.stack,
      ...(value.cause === undefined ? {} : { cause: redact(value.cause, depth + 1, seen) }),
    };
  }

  if (seen.has(value)) return '<циклическая ссылка>';
  if (depth >= MAX_DEPTH) return '<глубже ' + String(MAX_DEPTH) + ' уровней>';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? HIDDEN : redact(item, depth + 1, seen);
  }
  return result;
}
