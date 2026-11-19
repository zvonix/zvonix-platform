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

/**
 * Столбец, который на телефоне прячется: там в строке остаётся главное — что это, состояние и действия
 * ([DESIGN.md](../../../../docs/DESIGN.md), «Таблица»; «Три аудитории»: партнёр видит состояние SIM без прокрутки
 * вбок). Ставится одинаково на заголовок и на ячейку столбца.
 */
export const WIDE_ONLY = 'hidden md:table-cell';

/**
 * То же для широких таблиц, которым не хватает и 1024 с открытым меню: столбец появляется с 1280 (`FROM_XL`) или
 * 1536 (`FROM_2XL`). Чем столбец второстепеннее, тем позже: у линий клиента в админке «Запись» и «Номер для показа»
 * есть ещё в окне «Настроить».
 */
export const FROM_XL = 'hidden xl:table-cell';
export const FROM_2XL = 'hidden 2xl:table-cell';

/** Обёртка таблицы — одна на кабинет: рамка, карточка, своя прокрутка вбок (страница вбок не едет никогда). */
export const TABLE_FRAME = 'overflow-x-auto rounded-lg border border-border bg-card';

/** Заголовок столбца — одной высоты во всех таблицах. */
export const HEAD = 'h-8';

/** Число, которое сравнивают по строкам (суммы, счётчики, проценты): моноширинно и вправо. */
export const NUM = 'num text-right';
