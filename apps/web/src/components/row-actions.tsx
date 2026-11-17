import type { ReactNode } from 'react';

/**
 * Действия строки таблицы — значки с подсказкой, прижатые вправо, в одну линию
 * ([DESIGN.md](../../../../docs/DESIGN.md), «Таблица»). Ячейка ужимается до своих значков (`w-px`), так что
 * столбец действий одинаковой ширины во всех строках и не отнимает место у данных.
 */
export function RowActions({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-0.5">{children}</div>;
}

/**
 * Вид кнопки-значка в строке — один на все таблицы: прозрачная, 28 px (цель нажатия не меньше 24×24, WCAG 2.5.8),
 * значок 16 px. Подставляется в `FormDialog`, `ConfirmAction` и `Button` вместе с `tooltip`/`aria-label`.
 */
export const ROW_ICON = {
  variant: 'ghost',
  size: 'icon-xs',
  className: 'size-7 text-muted-foreground hover:text-foreground',
} as const;
