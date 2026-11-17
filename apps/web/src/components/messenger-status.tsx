'use client';

import { HintText, StatusDot, toneOf } from '@/components/status-dot';
import {
  MESSENGER_ACCOUNT_REASON_ACTION,
  MESSENGER_ACCOUNT_REASON_MEANING,
  MESSENGER_ACCOUNT_STATUS_MEANING,
  MESSENGER_ACCOUNT_STATUS_NAME,
  messengerAccountTone,
} from '@/lib/labels';

/**
 * Состояние аккаунта MAX: точка и слово, в подсказке — что это значит и что делать. Партнёру причина подсказывает
 * следующий шаг; сотруднику — где искать (`staff`). `note` дописывается в подсказку (время сверки с провайдером).
 */
export function MessengerAccountStatus({
  status,
  reason,
  staff = false,
  note,
}: {
  status: string;
  reason: string | null;
  staff?: boolean;
  note?: string | undefined;
}) {
  const name = MESSENGER_ACCOUNT_STATUS_NAME[status] ?? status;
  const meaning =
    (status === 'unavailable' && reason !== null
      ? MESSENGER_ACCOUNT_REASON_MEANING[reason]
      : undefined) ?? MESSENGER_ACCOUNT_STATUS_MEANING[status];
  const action = reason === null ? undefined : MESSENGER_ACCOUNT_REASON_ACTION[reason];
  const tip = [meaning, staff ? action?.staff : action?.partner, note]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ');

  return (
    <StatusDot
      tone={toneOf(messengerAccountTone(status))}
      label={name}
      reason={tip === '' ? undefined : tip}
    />
  );
}

/** Почему аккаунт на паузе (поле `rest` списка аккаунтов): причина словами — для партнёра и сотрудников. */
const REST_NAME = {
  health: 'много «нет MAX» после отправки',
  quiet: 'тихие часы',
  sleep: 'спит',
  minute: 'лимит в минуту',
  hour: 'лимит в час',
  day: 'лимит в сутки',
  warmup: 'прогрев: первые сутки',
} as const;

export type AccountRest =
  { readonly reason: keyof typeof REST_NAME; readonly until: string } | null | undefined;

/**
 * Ячейка «Пауза»: «до 16:42», причина и сколько осталось — в подсказке; паузы нет — прочерк (владелец, 2026-11-17:
 * строка таблицы — одна линия, подробности в подсказке). Окна лимитов скользящие — время посчитано сервером по самому
 * раннему сообщению в окне.
 */
export function AccountRestCell({ rest }: { rest: AccountRest }) {
  if (rest === null || rest === undefined) return <span className="text-faint">—</span>;
  const until = new Date(rest.until);
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  const sameDay = until.toDateString() === new Date().toDateString();
  const time = until.toLocaleString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
  });
  const left =
    minutes < 60
      ? `через ${String(minutes)} мин`
      : `через ${String(Math.floor(minutes / 60))} ч ${String(minutes % 60)} мин`;
  return (
    <StatusDot
      tone="warn"
      label={`до ${time}`}
      reason={`${REST_NAME[rest.reason]}; снова отправляет ${left}`}
    />
  );
}

/**
 * Ячейка «Лимиты»: при рекомендованной работе — «71 в сутки» (темп задаёт площадка, ADR-0090), иначе «в минуту / в час /
 * в сутки сейчас» числами; расшифровка и пометка о рекомендованной работе — в подсказке.
 */
export function AccountLimitsCell({
  recommended,
  perMinute,
  perHour,
  perDay,
}: {
  recommended: boolean;
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
}) {
  const value = (limit: number | null): string => (limit === null ? '—' : String(limit));
  if (recommended) {
    return (
      <HintText
        label={`${value(perDay)} в сутки`}
        reason="Рекомендованная работа: темп и лимиты задаёт площадка, лимиты тарифа не применяются. Число — сколько можно за сутки сейчас"
      />
    );
  }
  return (
    <HintText
      label={`${value(perMinute)} / ${value(perHour)} / ${value(perDay)}`}
      reason="В минуту / в час / в сутки сейчас"
    />
  );
}

/** Ячейка «Прогрев»: «5 из 28» с полоской хода; выключен или пройден — словом. */
export function WarmupCell({
  enabled,
  day,
  days,
}: {
  enabled: boolean;
  day: number | null;
  days: number;
}) {
  if (!enabled) return <span className="text-muted-foreground">выключен</span>;
  if (day === null) return <span className="text-muted-foreground">пройден</span>;
  const current = day + 1;
  return (
    <span
      className="inline-flex items-center gap-2 whitespace-nowrap"
      title={`Автопрогрев: ${String(current)}-е сутки из ${String(days)}`}
    >
      <span
        role="progressbar"
        aria-label="Автопрогрев"
        aria-valuemin={1}
        aria-valuemax={days}
        aria-valuenow={current}
        className="h-1.5 w-12 overflow-hidden rounded-full bg-border"
      >
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${String(Math.round((current / days) * 100))}%` }}
        />
      </span>
      <span>
        <span className="num">{String(current)}</span> из{' '}
        <span className="num">{String(days)}</span>
      </span>
    </span>
  );
}
