export interface ChartPoint {
  /** Момент, мс от начала эпохи. */
  readonly t: number;
  readonly v: number;
}

const WIDTH = 320;
const HEIGHT = 72;
const PAD_TOP = 4;
const PAD_BOTTOM = 4;

/**
 * Линия за период: площадь под ней, подписи наибольшего и наименьшего значения слева.
 *
 * Свой SVG без библиотеки графиков: нужна одна ломаная на несколько сотен точек
 * ([ADR-0065](../../../../docs/adr/0065-sostoyanie-serverov-i-istoriya.md)). Разрыв в данных
 * (источник молчал дольше трёх шагов) не соединяется линией — иначе провал выглядел бы
 * плавным спуском, а молчание узла — спокойной работой.
 */
export function LineChart({
  points,
  from,
  to,
  stepMs,
  floor = 0,
  ceiling,
  format,
  label,
}: {
  points: readonly ChartPoint[];
  /** Границы окна по времени: график всегда занимает весь период, даже если данных мало. */
  from: number;
  to: number;
  /** Шаг корзины: больший промежуток между точками считается разрывом. */
  stepMs: number;
  /** Нижняя граница шкалы; по умолчанию ноль. */
  floor?: number;
  /** Верхняя граница шкалы; по умолчанию — наибольшее значение. */
  ceiling?: number;
  format: (value: number) => string;
  /** Что показывает график — для чтения с экрана. */
  label: string;
}) {
  if (points.length === 0) {
    return (
      <div
        className="flex h-[72px] items-center justify-center rounded-sm bg-muted text-muted-foreground"
        role="img"
        aria-label={`${label}: нет данных`}
      >
        нет данных
      </div>
    );
  }

  const top = ceiling ?? Math.max(...points.map((point) => point.v), floor + 1);
  const span = Math.max(top - floor, 1);
  const x = (t: number) => ((t - from) / Math.max(to - from, 1)) * WIDTH;
  const y = (v: number) =>
    PAD_TOP +
    (1 - (Math.min(Math.max(v, floor), top) - floor) / span) * (HEIGHT - PAD_TOP - PAD_BOTTOM);

  // Сегменты между разрывами: у каждого своя линия и своя площадь.
  const segments: ChartPoint[][] = [];
  for (const point of points) {
    const last = segments.at(-1);
    const previous = last?.at(-1);
    if (last !== undefined && previous !== undefined && point.t - previous.t <= stepMs * 3) {
      last.push(point);
    } else {
      segments.push([point]);
    }
  }

  const line = (segment: readonly ChartPoint[]) =>
    segment
      .map((point, i) => `${i === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.v).toFixed(1)}`)
      .join(' ');
  const area = (segment: readonly ChartPoint[]) => {
    const first = segment[0];
    const last = segment.at(-1);
    if (first === undefined || last === undefined) return '';
    return `${line(segment)} L${x(last.t).toFixed(1)},${String(HEIGHT)} L${x(first.t).toFixed(1)},${String(HEIGHT)} Z`;
  };

  const lowest = Math.min(...points.map((point) => point.v));
  const highest = Math.max(...points.map((point) => point.v));

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        className="h-[72px] w-full text-primary"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: от ${format(lowest)} до ${format(highest)}`}
      >
        <line x1="0" x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="stroke-border" />
        {segments.map((segment) =>
          segment.length > 1 ? (
            <g key={segment[0]?.t}>
              <path d={area(segment)} fill="currentColor" opacity="0.12" />
              <path
                d={line(segment)}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ) : (
            <circle
              key={segment[0]?.t}
              cx={x(segment[0]?.t ?? 0)}
              cy={y(segment[0]?.v ?? 0)}
              r="2"
              fill="currentColor"
            />
          ),
        )}
      </svg>
      <span className="num pointer-events-none absolute left-1 top-0 text-muted-foreground">
        {format(top)}
      </span>
    </div>
  );
}
