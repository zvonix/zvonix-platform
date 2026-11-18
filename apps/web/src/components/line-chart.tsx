'use client';

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { useReducedMotion } from '@/components/day-chart';
import { ChartContainer, ChartTooltip } from '@/components/ui/chart';

export interface ChartPoint {
  /** Момент, мс от начала эпохи. */
  readonly t: number;
  /** Значение в процентах, 0–100. */
  readonly v: number;
}

const PLOT_HEIGHT = 120;
const TICKS = [0, 50, 100];

/**
 * График в процентах за период на Recharts — тот же блок Chart, что у столбцов по суткам
 * (ADR-0059, ревизия 2026-11-17; раньше — свой SVG по [ADR-0065](../../../../docs/adr/0065-sostoyanie-serverov-i-istoriya.md)).
 * Шкала 0–100 %, время по оси, при наведении — линия и значение на этот момент; графики одного
 * сервера наводятся вместе (`syncId`).
 *
 * Разрыв в данных (источник молчал дольше трёх шагов) линией не соединяется — иначе провал
 * выглядел бы плавным спуском, а молчание узла — спокойной работой.
 */
export function LineChart({
  title,
  points,
  from,
  to,
  stepMs,
  label,
  formatTime,
  syncId,
}: {
  title: string;
  points: readonly ChartPoint[];
  /** Границы окна по времени: график всегда занимает весь период, даже если данных мало. */
  from: number;
  to: number;
  /** Шаг корзины: больший промежуток между точками считается разрывом. */
  stepMs: number;
  /** Что показывает график — для чтения с экрана. */
  label: string;
  formatTime: (t: number) => string;
  /** Общий у графиков одного сервера: наведение встаёт на одно время на всех. */
  syncId: string;
}) {
  const reduced = useReducedMotion();

  // Разрыв — точка без значения между сегментами: Recharts не соединяет через неё.
  const data: { t: number; v: number | null }[] = [];
  for (const point of points) {
    const previous = data.at(-1);
    if (previous !== undefined && point.t - previous.t > stepMs * 3) {
      data.push({ t: previous.t + stepMs, v: null });
    }
    data.push({ t: point.t, v: point.v });
  }
  const latest = points.at(-1);
  const values = points.map((point) => point.v);

  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-medium">{title}</span>
        <span className="num text-muted-foreground">
          {latest === undefined ? 'нет данных' : `сейчас ${String(Math.round(latest.v))} %`}
        </span>
      </figcaption>

      {points.length === 0 ? (
        <div
          className="flex items-center justify-center rounded-sm bg-muted text-muted-foreground"
          style={{ height: PLOT_HEIGHT }}
          role="img"
          aria-label={`${label}: нет данных`}
        >
          нет данных
        </div>
      ) : (
        <ChartContainer
          className="aspect-auto w-full"
          style={{ height: PLOT_HEIGHT }}
          role="img"
          aria-label={`${label}: от ${String(Math.round(Math.min(...values)))} до ${String(Math.round(Math.max(...values)))} %`}
        >
          <AreaChart data={data} syncId={syncId} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} className="stroke-border-soft" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[from, to]}
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              minTickGap={40}
              tickFormatter={formatTime}
              className="num"
            />
            <YAxis
              width={44}
              domain={[0, 100]}
              ticks={TICKS}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => `${String(value)} %`}
              className="num"
            />
            <ChartTooltip
              isAnimationActive={false}
              cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3' }}
              content={({ active, payload }) => {
                const point = payload[0]?.payload as { t: number; v: number | null } | undefined;
                if (!active || point === undefined || point.v === null) return null;
                return (
                  <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md">
                    <span className="num font-semibold">{String(Math.round(point.v))} %</span>
                    <span className="num ml-2 text-muted-foreground">{formatTime(point.t)}</span>
                  </div>
                );
              }}
            />
            <Area
              dataKey="v"
              type="linear"
              stroke="var(--primary)"
              strokeWidth={1.5}
              fill="var(--primary)"
              fillOpacity={0.12}
              connectNulls={false}
              dot={false}
              activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
              isAnimationActive={!reduced}
              animationDuration={450}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </figure>
  );
}
