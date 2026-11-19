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

const SHORT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const SHORT_WITH_YEAR = new Intl.DateTimeFormat('ru-RU', {
  year: 'numeric',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Момент коротко — «19.11, 12:00», для столбца таблицы («Последний вызов» линии). Год пишется, только если он не
 * текущий: иначе прошлогодний вызов читался бы как сегодняшний.
 */
export function shortMoment(value: string | null | undefined, now: Date = new Date()): string {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.getFullYear() === now.getFullYear()
    ? SHORT.format(parsed)
    : SHORT_WITH_YEAR.format(parsed);
}

/**
 * Момент по часам пояса, а не браузера: «обнулится 29.10, 00:00» у правила, чьи сутки считаются по Москве
 * ([ADR-0102](../../../../docs/adr/0102-chasovoy-poyas-akkaunta-i-limity.md)). По часам браузера та же полночь читалась
 * бы как «04:00» и не совпадала с подписью пояса рядом.
 */
export function momentInZone(value: string | null | undefined, timeZone: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
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
