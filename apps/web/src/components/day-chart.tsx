'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip } from '@/components/ui/chart';

/** Что показывает график: оба ряда сложенными столбцами или один. */
export type ChartScope = 'all' | 'calls' | 'messages';

/** Сутки графика: высота — числом, а подписи — готовой строкой (деньги не считаются в `number`). */
export interface DayPoint {
  /** `ГГГГ-ММ-ДД`. */
  readonly day: string;
  readonly calls: number;
  readonly messages: number;
  readonly callsText: string;
  readonly messagesText: string;
  /** Сумма обоих рядов строкой — подпись над столбцом и итог подсказки. */
  readonly totalText: string;
}

const CONFIG = {
  calls: { label: 'Звонки', color: 'var(--chart-calls)' },
  messages: { label: 'Сообщения', color: 'var(--chart-messages)' },
} as const;

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
function useReducedMotion(): boolean {
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
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
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
 * Какие столбцы подписать числом: сначала наибольший, затем по убыванию, пока подписи
 * не начнут налезать друг на друга. На 7 сутках подписаны все, на 90 — вершины.
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
 * помещается, подсказка при наведении — у каждого, оба ряда сложенными столбцами или один.
 * Деньги приходят строкой API и показываются ею же; `number` — только высота столбца.
 */
export function DayChart({
  points,
  scope,
  label,
}: {
  points: readonly DayPoint[];
  scope: ChartScope;
  /** Что показывает график — для чтения с экрана: «Заработано по дням». */
  label: string;
}) {
  const reduced = useReducedMotion();
  const [ref, width] = useWidth();
  const series = scope === 'all' ? (['calls', 'messages'] as const) : ([scope] as const);
  const top = series.at(-1) ?? 'calls';
  const valueOf = (point: DayPoint): number => series.reduce((sum, key) => sum + point[key], 0);
  const textOf = (point: DayPoint): string =>
    scope === 'all' ? point.totalText : scope === 'calls' ? point.callsText : point.messagesText;

  const values = points.map(valueOf);
  const texts = points.map(textOf);
  const shown = labelled(values, texts, Math.max(0, width - Y_AXIS));
  const data = points.map((point) => ({ ...point }));

  return (
    <figure ref={ref} className="flex flex-col gap-1" aria-label={label}>
      {scope === 'all' && (
        <div className="flex gap-3 text-muted-foreground" aria-hidden>
          {series.map((key) => (
            <span key={key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-[2px]" style={{ background: CONFIG[key].color }} />
              {CONFIG[key].label}
            </span>
          ))}
        </div>
      )}
      <ChartContainer className="aspect-auto h-56 w-full">
        <BarChart
          accessibilityLayer
          data={data}
          margin={{ top: 18, right: 0, bottom: 0, left: 0 }}
          barCategoryGap={points.length > 45 ? 1 : '18%'}
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
                  {series.map((key) => (
                    <div key={key} className="flex items-center gap-2">
                      <span
                        className="h-0.5 w-3 rounded-full"
                        style={{ background: CONFIG[key].color }}
                      />
                      <span className="num font-semibold">
                        {key === 'calls' ? point.callsText : point.messagesText}
                      </span>
                      <span className="ml-auto pl-2 text-muted-foreground">
                        {CONFIG[key].label}
                      </span>
                    </div>
                  ))}
                  {scope === 'all' && (
                    <div className="flex items-center gap-2 border-t border-border pt-1">
                      <span className="num font-semibold">{point.totalText}</span>
                      <span className="ml-auto pl-2 text-muted-foreground">Всего</span>
                    </div>
                  )}
                </div>
              );
            }}
          />
          {series.map((key) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="day"
              fill={CONFIG[key].color}
              radius={key === top ? [4, 4, 0, 0] : 0}
              minPointSize={key === top ? 2 : 0}
              isAnimationActive={!reduced}
              animationDuration={450}
              animationEasing="ease-out"
            >
              {key === top && (
                <LabelList
                  dataKey={key}
                  content={({ x, y, width: barWidth, index }) => {
                    if (index === undefined || !shown.has(index)) return null;
                    return (
                      <text
                        x={Number(x) + Number(barWidth) / 2}
                        y={Number(y) - 5}
                        textAnchor="middle"
                        className="num fill-foreground text-[11px]"
                      >
                        {texts[index]}
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
