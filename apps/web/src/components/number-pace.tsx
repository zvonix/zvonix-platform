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
  /** Разных абонентов: предел и израсходованное ([ADR-0106](../../../../docs/adr/0106-rovnyy-temp-nomera-i-abonenty.md)). */
  readonly distinct_per_hour: number | null;
  readonly distinct_per_day: number | null;
  readonly distinct_used_hour: number;
  readonly distinct_used_day: number;
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
  // Исчерпаны новые абоненты: перезванивать знакомым номер ещё может, новым — нет.
  const distinctFull =
    (pace.distinct_per_day !== null && pace.distinct_used_day >= pace.distinct_per_day) ||
    (pace.distinct_per_hour !== null && pace.distinct_used_hour >= pace.distinct_per_hour);
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
  if (distinctFull) {
    return (
      <span
        className={`${className} text-warn`}
        title="Номер обзвонил столько разных абонентов, сколько разрешено: новым звонят другие номера, знакомым он перезванивает"
      >
        {block ? '' : ' · '}
        предел абонентов
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
