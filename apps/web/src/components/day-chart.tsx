'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip } from '@/components/ui/chart';

/** Что показывает сводка: оба продукта или один. */
export type ChartScope = 'all' | 'calls' | 'messages';

/** Ряд графика: название в легенде и подсказке, цвет — токен темы `--chart-*`. */
export interface DaySeries {
  readonly label: string;
  readonly color: string;
}

/** Цвета рядов: звонки и сообщения; у других графиков — первый и второй ряд. */
export const CHART_COLORS = {
  calls: 'var(--chart-calls)',
  messages: 'var(--chart-messages)',
} as const;

/**
 * Сутки графика: высоты рядов числами, подписи — готовыми строками (деньги не считаются в `number`).
 * `values[i]` и `texts[i]` — ряд `series[i]`.
 */
export interface DayPoint {
  /** `ГГГГ-ММ-ДД`. */
  readonly day: string;
  readonly values: readonly number[];
  readonly texts: readonly string[];
  /** Сумма рядов строкой — подпись над сложенным столбцом и итог подсказки. */
  readonly totalText: string;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** `ГГГГ-ММ-ДД` → `дд.мм`. */
const shortDay = (day: string): string => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

/** `ГГГГ-ММ-ДД` → «17 ноя, вт». */
const longDay = (day: string): string => {
  const date = new Date(`${day}T12:00:00Z`);
  return `${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ''}, ${WEEKDAYS[date.getUTCDay()] ?? ''}`;
};

/** Шкала слева: разряды через узкий пробел, без валюты — она в заголовке и подписях. */
const axisNumber = (value: number): string =>
  Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const REDUCE = '(prefers-reduced-motion: reduce)';

/** «Уменьшить движение» в системе — графики без анимации (DESIGN.md, «Движение»). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(REDUCE);
      query.addEventListener('change', notify);
      return () => {
        query.removeEventListener('change', notify);
      };
    },
    () => window.matchMedia(REDUCE).matches,
    () => true,
  );
}

/** Ширина области графика: от неё зависит, сколько подписей над столбцами поместится. */
function useWidth(): [React.RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}

const Y_AXIS = 48;
const CHAR_PX = 6.6;
const LABEL_GAP = 6;

/**
 * Какие места подписать числом: сначала наибольшее, затем по убыванию, пока подписи не начнут
 * налезать друг на друга. На 7 сутках подписаны все, на 90 — вершины. Место — столбец (или
 * столбик ряда в группе), его центр — `(index + 0.5) * step`.
 */
function labelled(
  values: readonly number[],
  texts: readonly string[],
  plotWidth: number,
): Set<number> {
  const step = values.length === 0 ? 0 : plotWidth / values.length;
  const order = values
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);
  const taken: { left: number; right: number }[] = [];
  const result = new Set<number>();
  for (const { index } of order) {
    const half = ((texts[index]?.length ?? 0) * CHAR_PX) / 2 + LABEL_GAP / 2;
    const center = step * (index + 0.5);
    const box = { left: center - half, right: center + half };
    if (box.left < 0 || box.right > plotWidth) continue;
    if (taken.some((other) => box.left < other.right && box.right > other.left)) continue;
    taken.push(box);
    result.add(index);
  }
  return result;
}

/**
 * Столбцы по суткам на Recharts (ADR-0059, ревизия 2026-11-17): числа над столбцами — сколько
 * помещается, подсказка при наведении — у каждого. Ряды сложенными столбцами (части целого: звонки
 * и сообщения) или рядом (разное: пришли и ушли). Деньги приходят строкой API и показываются ею же;
 * `number` — только высота.
 */
export function DayChart({
  points,
  series,
  label,
  stacked = true,
}: {
  points: readonly DayPoint[];
  series: readonly DaySeries[];
  /** Что показывает график — для чтения с экрана: «Заработано по дням». */
  label: string;
  stacked?: boolean;
}) {
  const reduced = useReducedMotion();
  const [ref, width] = useWidth();
  const plot = Math.max(0, width - Y_AXIS);
  const last = series.length - 1;

  // Подписи: над сложенным столбцом — сумма, в группе — каждый столбик своим числом.
  const shownStacked = labelled(
    points.map((point) => point.values.reduce((sum, value) => sum + value, 0)),
    points.map((point) => point.totalText),
    plot,
  );
  const shownGrouped = labelled(
    points.flatMap((point) => series.map((_, i) => point.values[i] ?? 0)),
    points.flatMap((point) => series.map((_, i) => point.texts[i] ?? '')),
    plot,
  );
  const isShown = (index: number, seriesIndex: number): boolean =>
    stacked ? shownStacked.has(index) : shownGrouped.has(index * series.length + seriesIndex);
  const textAt = (index: number, seriesIndex: number): string =>
    (stacked ? points[index]?.totalText : points[index]?.texts[seriesIndex]) ?? '';

  return (
    <figure ref={ref} className="flex flex-col gap-1" aria-label={label}>
      {series.length > 1 && (
        <div className="flex gap-3 text-muted-foreground" aria-hidden>
          {series.map((entry) => (
            <span key={entry.label} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-[2px]" style={{ background: entry.color }} />
              {entry.label}
            </span>
          ))}
        </div>
      )}
      <ChartContainer className="aspect-auto h-56 w-full">
        <BarChart
          accessibilityLayer
          data={points}
          margin={{ top: 18, right: 0, bottom: 0, left: 0 }}
          barCategoryGap={points.length > 45 ? 1 : '18%'}
          barGap={1}
        >
          <CartesianGrid vertical={false} strokeDasharray="0" className="stroke-border-soft" />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={18}
            tickFormatter={shortDay}
            className="num"
          />
          <YAxis
            width={Y_AXIS}
            tickLine={false}
            axisLine={false}
            tickCount={4}
            allowDecimals={false}
            tickFormatter={axisNumber}
            className="num"
          />
          <ChartTooltip
            cursor={{ fill: 'var(--muted)' }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const point = payload[0]?.payload as DayPoint | undefined;
              if (!active || point === undefined) return null;
              return (
                <div className="grid min-w-36 gap-1 rounded-md border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md">
                  <div className="text-muted-foreground">{longDay(point.day)}</div>
                  {series.map((entry, i) => (
                    <div key={entry.label} className="flex items-center gap-2">
                      <span
                        className="h-0.5 w-3 rounded-full"
                        style={{ background: entry.color }}
                      />
                      <span className="num font-semibold">{point.texts[i]}</span>
                      <span className="ml-auto pl-2 text-muted-foreground">{entry.label}</span>
                    </div>
                  ))}
                  {stacked && series.length > 1 && (
                    <div className="flex items-center gap-2 border-t border-border pt-1">
                      <span className="num font-semibold">{point.totalText}</span>
                      <span className="ml-auto pl-2 text-muted-foreground">Всего</span>
                    </div>
                  )}
                </div>
              );
            }}
          />
          {series.map((entry, seriesIndex) => (
            <Bar
              key={entry.label}
              dataKey={(point: DayPoint) => point.values[seriesIndex] ?? 0}
              name={entry.label}
              {...(stacked ? { stackId: 'day' } : {})}
              fill={entry.color}
              radius={!stacked || seriesIndex === last ? [4, 4, 0, 0] : 0}
              minPointSize={!stacked || seriesIndex === last ? 2 : 0}
              isAnimationActive={!reduced}
              animationDuration={450}
              animationEasing="ease-out"
            >
              {(!stacked || seriesIndex === last) && (
                <LabelList
                  content={({ x, y, width: barWidth, index }) => {
                    if (index === undefined || !isShown(index, seriesIndex)) return null;
                    return (
                      <text
                        x={Number(x) + Number(barWidth) / 2}
                        y={Number(y) - 5}
                        textAnchor="middle"
                        className="num fill-foreground text-[11px]"
                      >
                        {textAt(index, seriesIndex)}
                      </text>
                    );
                  }}
                />
              )}
            </Bar>
          ))}
        </BarChart>
      </ChartContainer>
    </figure>
  );
}
