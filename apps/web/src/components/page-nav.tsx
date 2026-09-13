'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Переход по страницам с явным числом записей.
 *
 * Не бесконечная прокрутка: [DESIGN.md](../../../../docs/DESIGN.md) запрещает её
 * в таблицах с деньгами прямо, и по той же причине она не годится здесь — «сколько
 * всего заявок ждёт» и «сколько записей в журнале за период» это ответ на вопрос,
 * а не украшение счётчика.
 */
export function PageNav({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const canBack = offset > 0;
  const canForward = to < total;

  return (
    <div className="flex items-center gap-2">
      <span className="num text-muted-foreground">
        {total === 0 ? 'ничего не найдено' : `${String(from)}–${String(to)} из ${String(total)}`}
      </span>

      <button
        type="button"
        aria-label="Предыдущая страница"
        disabled={!canBack}
        onClick={() => {
          onChange(Math.max(0, offset - limit));
        }}
        className="rounded-md border border-border p-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-40"
      >
        <ChevronLeft size={14} strokeWidth={2} aria-hidden />
      </button>

      <button
        type="button"
        aria-label="Следующая страница"
        disabled={!canForward}
        onClick={() => {
          onChange(offset + limit);
        }}
        className="rounded-md border border-border p-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-40"
      >
        <ChevronRight size={14} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}
