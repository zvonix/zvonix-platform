'use client';

import { cn } from 'cn';
import type * as React from 'react';
import { ResponsiveContainer, Tooltip } from 'recharts';

/**
 * Обёртка графика из блока Chart shadcn/ui (Recharts), урезанная до того, что кабинет использует:
 * контейнер по ширине родителя с цветами осей и сетки из токенов темы и подсказка. Цвета рядов
 * задаёт сам график токенами `--chart-*` (ADR-0059, ревизия 2026-11-17), поэтому `ChartStyle`
 * и готовое содержимое подсказки блока не взяты.
 */
function ChartContainer({
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  children: React.ComponentProps<typeof ResponsiveContainer>['children'];
}) {
  return (
    <div
      data-slot="chart"
      className={cn(
        'flex justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-layer]:outline-hidden [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-surface]:outline-hidden',
        className,
      )}
      {...props}
    >
      <ResponsiveContainer initialDimension={{ width: 320, height: 200 }}>
        {children}
      </ResponsiveContainer>
    </div>
  );
}

const ChartTooltip = Tooltip;

export { ChartContainer, ChartTooltip };
