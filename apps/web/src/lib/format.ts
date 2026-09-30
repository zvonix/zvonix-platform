/**
 * Отображение времени.
 *
 * Часовой пояс — браузера, а не сервера: платформа федеральная, и оператор в Екатеринбурге
 * разбирает инцидент по своим часам. В API всё остаётся в UTC (`timestamptz`,
 * [ADR-0016](../../../../docs/adr/0016-soglasheniya-shemy-bd.md)) — переводится
 * только показ.
 */

const FULL = new Intl.DateTimeFormat('ru-RU', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Момент до секунд. Прочерк вместо пустоты: пустая ячейка читается как «не загрузилось». */
export function moment(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : FULL.format(parsed);
}

/** Момент в прошлом? Нужно, чтобы не пугать истёкшей блокировкой. */
export function isFuture(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now();
}

/**
 * Длительность разговора — минуты и секунды.
 *
 * Часов здесь нет намеренно: счёт идёт на минуты, и `0:05:12` вместо `5:12` только
 * мешает сравнивать строки таблицы глазами.
 */
export function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`;
}

const PLURAL = new Intl.PluralRules('ru-RU');

/**
 * Слово при числе по правилам русского: «1 звонок», «3 звонка», «5 звонков».
 * Формы — единственное, «несколько» (2–4), «много».
 */
export function plural(count: number, forms: readonly [string, string, string]): string {
  const rule = PLURAL.select(count);
  return rule === 'one' ? forms[0] : rule === 'few' ? forms[1] : forms[2];
}
