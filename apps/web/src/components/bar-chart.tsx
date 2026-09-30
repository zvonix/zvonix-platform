'use client';

export interface Bar {
  /** Подпись столбца: сутки. */
  readonly label: string;
  readonly value: number;
  /** Что видно при наведении. */
  readonly title: string;
}

/**
 * Столбчатый график из обычной разметки — без библиотеки (ADR-0059).
 *
 * Высота столбца — доля от наибольшего; ноль остаётся тонкой чертой, чтобы день без
 * вызовов читался как «ноль», а не как «данных нет». Под графиком — первые и последние
 * сутки, над ним — наибольшее значение: шкалу по осям для двух десятков столбцов
 * рисовать незачем.
 */
export function BarChart({
  bars,
  peak,
  summary,
}: {
  bars: readonly Bar[];
  /** Наибольшее значение уже в виде строки: «12 400 ₽», «31 вызов». */
  peak: string;
  /** Текст для чтения с экрана. */
  summary: string;
}) {
  const max = Math.max(0, ...bars.map((bar) => bar.value));
  const first = bars[0]?.label ?? '';
  const last = bars.at(-1)?.label ?? '';

  return (
    <figure className="flex flex-col gap-1" aria-label={summary}>
      <div className="text-muted-foreground">{peak}</div>
      <div
        role="img"
        aria-label={summary}
        className="flex h-40 items-end gap-px border-b border-border"
      >
        {bars.map((bar) => (
          <div
            key={bar.label}
            title={bar.title}
            className="min-w-[2px] flex-1 rounded-t-[2px]"
            style={{
              height: max === 0 || bar.value === 0 ? '2px' : `${String((bar.value / max) * 100)}%`,
              background: bar.value === 0 ? 'var(--border)' : 'var(--ok)',
            }}
          />
        ))}
      </div>
      <div className="num flex justify-between text-muted-foreground">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </figure>
  );
}
