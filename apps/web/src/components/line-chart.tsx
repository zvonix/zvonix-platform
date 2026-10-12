export interface ChartPoint {
  /** Момент, мс от начала эпохи. */
  readonly t: number;
  /** Значение в процентах, 0–100. */
  readonly v: number;
}

const PLOT_HEIGHT = 88;
const TICKS = [100, 50, 0] as const;

/** Ближайшая к моменту точка, если она не дальше полутора шагов; иначе `undefined` (там разрыв). */
function pointNear(
  points: readonly ChartPoint[],
  t: number,
  stepMs: number,
): ChartPoint | undefined {
  let best: ChartPoint | undefined;
  for (const point of points) {
    if (best === undefined || Math.abs(point.t - t) < Math.abs(best.t - t)) best = point;
  }
  return best !== undefined && Math.abs(best.t - t) <= stepMs * 1.5 ? best : undefined;
}

/**
 * График в процентах за период: шкала 0–100 %, время по краям, при наведении — вертикальная линия
 * и значение на этот момент.
 *
 * Свой SVG без библиотеки графиков: нужна одна ломаная на несколько сотен точек
 * ([ADR-0065](../../../../docs/adr/0065-sostoyanie-serverov-i-istoriya.md)). Подписи — обычным
 * текстом, а не внутри SVG: линия растягивается по ширине, и текст в ней сплющился бы.
 * Разрыв в данных (источник молчал дольше трёх шагов) не соединяется линией — иначе провал
 * выглядел бы плавным спуском, а молчание узла — спокойной работой.
 *
 * Наведение общее у всех графиков сервера: момент хранит родитель (`hoverAt`), и линия встаёт
 * на одно время на всех.
 */
export function LineChart({
  title,
  points,
  from,
  to,
  stepMs,
  label,
  formatTime,
  hoverAt,
  onHover,
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
  hoverAt: number | null;
  onHover: (t: number | null) => void;
}) {
  const span = Math.max(to - from, 1);
  const xPercent = (t: number) => Math.min(100, Math.max(0, ((t - from) / span) * 100));
  const yPercent = (v: number) => 100 - Math.min(100, Math.max(0, v));

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
      .map(
        (point, i) =>
          `${i === 0 ? 'M' : 'L'}${xPercent(point.t).toFixed(2)},${yPercent(point.v).toFixed(2)}`,
      )
      .join(' ');
  const area = (segment: readonly ChartPoint[]) => {
    const first = segment[0];
    const last = segment.at(-1);
    if (first === undefined || last === undefined) return '';
    return `${line(segment)} L${xPercent(last.t).toFixed(2)},100 L${xPercent(first.t).toFixed(2)},100 Z`;
  };

  const shown = hoverAt === null ? points.at(-1) : pointNear(points, hoverAt, stepMs);
  const hovered = hoverAt === null ? undefined : shown;

  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-medium">{title}</span>
        <span className="num text-muted-foreground" aria-live="off">
          {shown === undefined
            ? hoverAt === null
              ? 'нет данных'
              : `${formatTime(hoverAt)} · нет замера`
            : `${String(Math.round(shown.v))} %${hovered === undefined ? '' : ` · ${formatTime(hovered.t)}`}`}
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
        <div className="flex gap-1.5">
          <div
            className="num flex w-11 shrink-0 flex-col justify-between whitespace-nowrap text-right text-muted-foreground"
            style={{ height: PLOT_HEIGHT }}
            aria-hidden
          >
            {TICKS.map((tick) => (
              <span key={tick} className="leading-none">
                {String(tick)} %
              </span>
            ))}
          </div>
          <div
            className="relative min-w-0 flex-1 touch-pan-y"
            style={{ height: PLOT_HEIGHT }}
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              if (box.width <= 0) return;
              const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
              onHover(from + fraction * span);
            }}
            onPointerLeave={() => {
              onHover(null);
            }}
          >
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full text-primary"
              role="img"
              aria-label={`${label}: от ${String(Math.round(Math.min(...points.map((p) => p.v))))} до ${String(Math.round(Math.max(...points.map((p) => p.v))))} %`}
            >
              {TICKS.map((tick) => (
                <line
                  key={tick}
                  x1="0"
                  x2="100"
                  y1={yPercent(tick)}
                  y2={yPercent(tick)}
                  className="stroke-border"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {segments.map((segment) =>
                segment.length > 1 ? (
                  <g key={segment[0]?.t}>
                    <path d={area(segment)} fill="currentColor" opacity="0.12" />
                    <path
                      d={line(segment)}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                ) : null,
              )}
              {hovered !== undefined && (
                <line
                  x1={xPercent(hovered.t)}
                  x2={xPercent(hovered.t)}
                  y1="0"
                  y2="100"
                  className="stroke-muted-foreground"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
            {/* Одиночные точки (замер между разрывами) и маркер наведения — кружками поверх: в растянутом SVG они стали бы овалами. */}
            {segments.map((segment) =>
              segment.length === 1 && segment[0] !== undefined ? (
                <span
                  key={segment[0].t}
                  className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
                  style={{
                    left: `${String(xPercent(segment[0].t))}%`,
                    top: `${String(yPercent(segment[0].v))}%`,
                  }}
                />
              ) : null,
            )}
            {hovered !== undefined && (
              <span
                className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-primary"
                style={{
                  left: `${String(xPercent(hovered.t))}%`,
                  top: `${String(yPercent(hovered.v))}%`,
                }}
              />
            )}
          </div>
        </div>
      )}

      <div className="num flex justify-between pl-[50px] text-muted-foreground" aria-hidden>
        <span>{formatTime(from)}</span>
        <span>{formatTime(to)}</span>
      </div>
    </figure>
  );
}
