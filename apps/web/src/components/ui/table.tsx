'use client';

import * as React from 'react';
import { cn } from 'cn';

/**
 * Прокручивается ли блок вбок сейчас. Меряется заново при смене ширины окна и таблицы:
 * строки приходят после первого показа и раздвигают столбцы.
 */
function useHorizontalOverflow(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [overflowing, setOverflowing] = React.useState(false);
  React.useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const measure = () => {
      setOverflowing(element.scrollWidth > element.clientWidth + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild !== null) observer.observe(element.firstElementChild);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return overflowing;
}

/**
 * Прокручиваемый вбок блок получает фокус и подпись: без фокуса правую часть таблицы
 * без мыши не увидеть (WCAG 2.1.1; axe `scrollable-region-focusable` на 390 px
 * в восьми разделах, `pnpm ui:screens` 2026-09-22). Только пока прокрутка есть —
 * иначе каждая таблица добавляла бы лишнюю остановку `Tab`.
 */
function Table({ className, ...props }: React.ComponentProps<'table'>) {
  const container = React.useRef<HTMLDivElement>(null);
  const scrollable = useHorizontalOverflow(container);
  return (
    <div
      ref={container}
      data-slot="table-container"
      className={cn(
        'relative w-full overflow-x-auto outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        // Тень у края, за которым есть ещё столбцы: без неё таблица выглядит обрезанной.
        scrollable && 'scroll-shadow-x',
      )}
      {...(scrollable
        ? {
            tabIndex: 0,
            role: 'region',
            'aria-label': props['aria-label'] ?? 'Таблица, прокручивается вбок',
          }
        : {})}
    >
      <table
        data-slot="table"
        className={cn('w-full caption-bottom text-sm', className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'p-2 align-middle whitespace-nowrap [&[colspan]]:whitespace-normal [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
