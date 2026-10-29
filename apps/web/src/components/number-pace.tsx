/**
 * Прогрев и рекомендованная работа номера SIM или SIP-провайдера
 * ([ADR-0105](../../../../docs/adr/0105-progrev-i-rekomendovannaya-rabota-nomera.md)). Показывается только то, что
 * требует внимания: прогрев идёт или предел исчерпан.
 */

export interface NumberPaceView {
  /** Сутки прогрева с единицы; пусто — прогрет или прогрев выключен. */
  readonly warmup_day: number | null;
  readonly per_hour: number | null;
  readonly per_day: number | null;
  readonly used_hour: number;
  readonly used_day: number;
}

const WARMUP_DAYS = 14;

export function NumberPace({
  pace,
  block = false,
}: {
  pace: NumberPaceView | undefined;
  block?: boolean;
}) {
  if (pace === undefined) return null;
  const dayFull = pace.per_day !== null && pace.used_day >= pace.per_day;
  const hourFull = pace.per_hour !== null && pace.used_hour >= pace.per_hour;
  const limits = [
    pace.per_hour === null ? null : `в час до ${String(pace.per_hour)}`,
    pace.per_day === null ? null : `в сутки до ${String(pace.per_day)}`,
  ]
    .filter((part) => part !== null)
    .join(', ');
  const title =
    pace.warmup_day === null
      ? `Рекомендованная работа номера: ${limits}. Лишние вызовы уходят на другие номера`
      : `Новый номер звонит понемногу, чтобы оператор не заблокировал его за массовые звонки: ${limits}. Каждые сутки больше, полностью — через ${String(WARMUP_DAYS)} суток`;
  const className = block ? 'block' : '';

  if (dayFull || hourFull) {
    return (
      <span className={`${className} text-warn`} title={title}>
        {block ? '' : ' · '}
        {dayFull ? 'предел суток' : 'предел часа'}
      </span>
    );
  }
  if (pace.warmup_day === null) return null;
  return (
    <span className={`${className} text-muted-foreground`} title={title}>
      {block ? '' : ' · '}
      прогрев {pace.warmup_day}/{WARMUP_DAYS}
      {pace.per_day === null
        ? ''
        : ` · ${String(pace.used_day)} из ${String(pace.per_day)} за сутки`}
    </span>
  );
}
