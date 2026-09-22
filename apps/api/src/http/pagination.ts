/**
 * Границы выборки для списочных обработчиков.
 *
 * Одно место на всё API: без верхней границы запрос без параметра выгружает таблицу
 * целиком, и узнают об этом на журнале в миллион строк. Раньше эта функция лежала
 * двумя одинаковыми копиями в разных контроллерах — расхождение копий заметили бы
 * не раньше, чем одна из них перестала бы ограничивать.
 */

/** Сколько записей отдаётся, когда клиент не сказал сколько. */
const DEFAULT_LIMIT = 100;

/** Потолок: больше не отдаётся, сколько бы ни попросили. */
const MAX_LIMIT = 1000;

/**
 * Размер страницы.
 *
 * Мусор и отрицательное значение дают умолчание, а не отказ: список — не то место,
 * где опечатка в адресе должна возвращать ошибку вместо данных.
 */
export function boundedLimit(raw: string | undefined, max: number = MAX_LIMIT): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.min(DEFAULT_LIMIT, max);
  return Math.min(parsed, max);
}

/** Смещение страницы. Отрицательное и нечисловое — ноль: это начало списка. */
export function boundedOffset(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}
