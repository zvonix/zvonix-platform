/**
 * Прогрев и рекомендованная работа номера SIM или SIP-провайдера
 * ([ADR-0105](../../../../docs/adr/0105-progrev-i-rekomendovannaya-rabota-nomera.md)). Показывается только то, что
 * требует внимания: прогрев идёт или предел исчерпан, номер спит или отдыхает после звонка. Без сна и паузы партнёр
 * видел «0 из 11 за сутки» и не понимал, почему номер не звонит (владелец, 2026-11-14).
 */

import { isFuture } from '@/lib/format';

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
  /** Пауза после прошлого вызова: до какого времени номер отдыхает; пусто — свободен. */
  readonly resting_until: string | null;
  /** Сон номера (ADR-0107): до какого времени спит; пусто — не спит. */
  readonly asleep_until: string | null;
  /** «Плохой» номер: мало настоящих ответов, пределы вдвое ниже. */
  readonly poor: boolean;
  /** Оператор номера тормозит (ADR-0108): у него недавно сняли SIM, пределы ниже. */
  readonly braked: boolean;
}

const WARMUP_DAYS = 14;

/**
 * Работа номера одним словом для строки таблицы — самое важное из прогрева, пределов, сна и паузы; всё остальное
 * в подсказке ([DESIGN.md](../../../../docs/DESIGN.md), «Таблица»). Порядок — от того, что не даёт звонить, к тому,
 * что лишь замедляет. Пусто — номер работает без ограничений, говорить не о чем.
 */
export function paceSummary(
  pace: NumberPaceView | undefined,
): { tone: 'warn' | 'off'; label: string; reason: string } | null {
  if (pace === undefined) return null;
  const limits = [
    pace.per_hour === null ? null : `в час до ${String(pace.per_hour)}`,
    pace.per_day === null ? null : `в сутки до ${String(pace.per_day)}`,
  ]
    .filter((part) => part !== null)
    .join(', ');
  const used =
    pace.per_day === null
      ? ''
      : ` Сегодня ${String(pace.used_day)} из ${String(pace.per_day)}.`;
  const warmup =
    pace.warmup_day === null
      ? ''
      : ` Прогрев: сутки ${String(pace.warmup_day)} из ${String(WARMUP_DAYS)}.`;

  if (pace.per_day !== null && pace.used_day >= pace.per_day) {
    return {
      tone: 'warn',
      label: 'предел суток',
      reason: `Номер сделал столько вызовов, сколько рекомендовано на сутки (${limits}). Лишние уходят на другие номера.${warmup}`,
    };
  }
  if (pace.per_hour !== null && pace.used_hour >= pace.per_hour) {
    return {
      tone: 'warn',
      label: 'предел часа',
      reason: `Номер сделал столько вызовов, сколько рекомендовано на час (${limits}).${used}${warmup}`,
    };
  }
  if (pace.poor) {
    return {
      tone: 'warn',
      label: 'мало ответов',
      reason:
        'За сутки на этот номер почти не отвечают или сбрасывают в первые секунды — так оператор видит обзвон. Пределы номера вдвое ниже, пока ответов не станет больше.',
    };
  }
  if (pace.braked) {
    return {
      tone: 'warn',
      label: 'оператор тормозит',
      reason:
        'За последние 7 суток у этого оператора сняли несколько SIM. Все его номера звонят реже, торможение снимется само.',
    };
  }
  if (
    (pace.distinct_per_day !== null && pace.distinct_used_day >= pace.distinct_per_day) ||
    (pace.distinct_per_hour !== null && pace.distinct_used_hour >= pace.distinct_per_hour)
  ) {
    return {
      tone: 'warn',
      label: 'предел абонентов',
      reason:
        'Номер обзвонил столько разных абонентов, сколько разрешено: новым звонят другие номера, знакомым он перезванивает.',
    };
  }
  if (pace.asleep_until !== null && isFuture(pace.asleep_until)) {
    return {
      tone: 'off',
      label: `спит до ${CLOCK.format(new Date(pace.asleep_until))}`,
      reason: `Несколько часов в сутки номер не звонит — живой человек ночью спит. Вызовы в это время идут через другие номера.${used}${warmup}`,
    };
  }
  if (pace.resting_until !== null && isFuture(pace.resting_until)) {
    return {
      tone: 'off',
      label: 'пауза',
      reason: `Пауза после звонка до ${CLOCK_SECONDS.format(new Date(pace.resting_until))}: живой человек не звонит без перерыва.${used}${warmup}`,
    };
  }
  if (pace.warmup_day !== null) {
    return {
      tone: 'off',
      label: `прогрев ${String(pace.warmup_day)}/${String(WARMUP_DAYS)}`,
      reason: `Новый номер звонит понемногу, чтобы оператор не заблокировал его за массовые звонки: ${limits}. Каждые сутки больше, полностью — через ${String(WARMUP_DAYS)} суток.${used}`,
    };
  }
  return null;
}

const CLOCK = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const CLOCK_SECONDS = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function NumberPace({
  pace,
  block = false,
}: {
  pace: NumberPaceView | undefined;
  block?: boolean;
}) {
  if (pace === undefined) return null;
  return (
    <>
      <PaceStatus pace={pace} block={block} />
      <PaceWait pace={pace} block={block} />
    </>
  );
}

/**
 * Почему номер сейчас не звонит, хотя предел не исчерпан: спит (ADR-0107) или отдыхает после прошлого вызова. Время —
 * по часам браузера, как везде в кабинете. Истёкшее не показывается: список обновляется раз в несколько секунд.
 */
function PaceWait({ pace, block }: { pace: NumberPaceView; block: boolean }) {
  const className = `${block ? 'block' : ''} text-muted-foreground`;
  const prefix = block ? '' : ' · ';
  if (pace.asleep_until !== null && isFuture(pace.asleep_until)) {
    return (
      <span
        className={className}
        title="Сон номера: несколько часов в сутки номер не звонит — живой человек ночью спит. Часы свои у каждого номера, засыпает он между 20:00 и 08:00 по Москве; вызовы в это время идут через другие номера"
      >
        {prefix}спит до {CLOCK.format(new Date(pace.asleep_until))}
      </span>
    );
  }
  if (pace.resting_until !== null && isFuture(pace.resting_until)) {
    return (
      <span
        className={className}
        title="Пауза после звонка: живой человек не звонит без перерыва. Пока номер отдыхает, вызовы идут через другие номера"
      >
        {prefix}пауза до {CLOCK_SECONDS.format(new Date(pace.resting_until))}
      </span>
    );
  }
  return null;
}

/** Прогрев и пределы номера. */
function PaceStatus({ pace, block }: { pace: NumberPaceView; block: boolean }) {
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
  if (pace.poor) {
    return (
      <span
        className={`${className} text-warn`}
        title="За сутки на этот номер почти не отвечают или сбрасывают в первые секунды — так оператор видит обзвон. Пределы номера вдвое ниже, пока ответов не станет больше"
      >
        {block ? '' : ' · '}
        мало ответов
      </span>
    );
  }
  if (pace.braked) {
    return (
      <span
        className={`${className} text-warn`}
        title="За последние 7 суток у этого оператора сняли несколько SIM — оператор начал резать номера. Все его номера звонят реже, торможение снимется само"
      >
        {block ? '' : ' · '}
        оператор тормозит
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
