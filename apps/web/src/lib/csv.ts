/**
 * Выгрузка таблиц в CSV ([ADR-0061](../../../../docs/adr/0061-vygruzka-csv.md)).
 *
 * Собирается в браузере из тех же ответов API, что рисуют экран: каждая роль получает
 * ровно то, что уже видит (ADR-0014), и второго пути данных наружу нет.
 */

import { request } from './api';

/** Разделитель — точка с запятой: русская Excel открывает такой файл столбцами, а запятую — одной ячейкой. */
const SEPARATOR = ';';

/** Предел выгрузки: больше строк браузеру собирать в памяти незачем — сужайте период. */
export const EXPORT_ROWS_MAX = 10_000;

/** Страница API: у списков вызовов предел 200. */
const PAGE = 200;

/**
 * Ячейка, начинающаяся с «=», «@» или «+/-» перед не-цифрой, Excel принимает за формулу:
 * имя линии или клиента, заданное человеком, стало бы командой в чужой таблице. Перед такой
 * ячейкой ставится апостроф. Номера и суммы со знаком не затрагиваются.
 */
const FORMULA = /^(?:[=@\t\r]|[+-](?!\d))/u;

export function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = FORMULA.test(text) ? `'${text}` : text;
  return /[";\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Метка порядка байтов UTF-8. */
const BOM = String.fromCodePoint(0xfeff);

/** Файл целиком: метка порядка байтов — чтобы Excel не принял кириллицу за однобайтовую. */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(SEPARATOR));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** Отдаёт текст браузеру как файл. */
export function saveCsv(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Имя файла с сегодняшней датой по часам человека: `вызовы-2026-10-01.csv`. */
export function csvName(base: string, now = new Date()): string {
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
  return `${base}-${day}.csv`;
}

export interface LoadedCalls<T> {
  readonly rows: T[];
  readonly total: number;
  readonly truncated: boolean;
}

/**
 * Все страницы списка вызовов под текущим отбором — не больше `EXPORT_ROWS_MAX`.
 * `truncated` — в отборе строк больше, чем выгружено.
 */
export async function loadAllCalls<T>(
  path: string,
  filters: URLSearchParams,
): Promise<LoadedCalls<T>> {
  const rows: T[] = [];
  let total = 0;

  while (rows.length < EXPORT_ROWS_MAX) {
    const query = new URLSearchParams(filters);
    query.set('limit', String(PAGE));
    query.set('offset', String(rows.length));
    const page = await request<{ calls: T[]; total: number }>(`${path}?${query.toString()}`);
    total = page.total;
    rows.push(...page.calls);
    if (page.calls.length < PAGE || rows.length >= total) break;
  }
  return { rows, total, truncated: total > rows.length };
}
