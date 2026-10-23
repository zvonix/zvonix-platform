'use client';

import { Hint } from '@/components/hint';
import {
  MESSENGER_ACCOUNT_REASON_ACTION,
  MESSENGER_ACCOUNT_REASON_MEANING,
  MESSENGER_ACCOUNT_STATUS_MEANING,
  MESSENGER_ACCOUNT_STATUS_NAME,
  messengerAccountTone,
} from '@/lib/labels';

/**
 * Состояние аккаунта MAX: цветная метка и «?» с объяснением, что это значит и что делать. Партнёру причина
 * подсказывает следующий шаг; сотруднику — где искать (`staff`).
 */
export function MessengerAccountStatus({
  status,
  reason,
  staff = false,
}: {
  status: string;
  reason: string | null;
  staff?: boolean;
}) {
  const name = MESSENGER_ACCOUNT_STATUS_NAME[status] ?? status;
  const meaning =
    (status === 'unavailable' && reason !== null
      ? MESSENGER_ACCOUNT_REASON_MEANING[reason]
      : undefined) ?? MESSENGER_ACCOUNT_STATUS_MEANING[status];
  const action = reason === null ? undefined : MESSENGER_ACCOUNT_REASON_ACTION[reason];

  return (
    <span className="inline-flex items-center gap-1">
      <span className={`rounded-md px-2 py-0.5 whitespace-nowrap ${messengerAccountTone(status)}`}>
        {name}
      </span>
      {meaning !== undefined && (
        <Hint label={`Что значит «${name}»`}>
          <p className="font-semibold">{name}</p>
          <p className="pt-1">{meaning}</p>
          {action !== undefined && (
            <p className="pt-2 text-muted-foreground">{staff ? action.staff : action.partner}</p>
          )}
        </Hint>
      )}
    </span>
  );
}

/** Почему аккаунт на паузе (поле `rest` списка аккаунтов): причина словами — для партнёра и сотрудников. */
const REST_NAME = {
  health: 'много «нет MAX» после отправки',
  quiet: 'тихие часы',
  minute: 'лимит в минуту',
  hour: 'лимит в час',
  day: 'лимит в сутки',
} as const;

export type AccountRest =
  { readonly reason: keyof typeof REST_NAME; readonly until: string } | null | undefined;

/**
 * Ячейка «Пауза»: «до 16:42 · лимит в час», сколько осталось — в подсказке; паузы нет — прочерк (владелец, 2026-10-23: время и
 * причина в одну строку, без второй строки «через 12 мин»). Окна лимитов скользящие — время посчитано сервером по самому раннему
 * сообщению в окне.
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
    <span className="text-warn" title={`Снова отправляет ${left}`}>
      до <span className="num">{time}</span> · {REST_NAME[rest.reason]}
    </span>
  );
}

/**
 * Ячейка «Лимиты»: при рекомендованной работе — «71 в сутки» и метка «реком.» (темп задаёт площадка, ADR-0090), иначе
 * «в минуту / в час / в сутки сейчас» числами; расшифровка — в подсказке.
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
      <span title="Рекомендованная работа: темп и лимиты задаёт площадка, лимиты тарифа не применяются. Число — сколько можно за сутки сейчас">
        <span className="mr-1.5 rounded bg-muted px-1 py-px text-xs text-muted-foreground">
          реком.
        </span>
        <span className="num">{value(perDay)}</span> в сутки
      </span>
    );
  }
  return (
    <span className="num" title="В минуту / в час / в сутки сейчас">
      {value(perMinute)} / {value(perHour)} / {value(perDay)}
    </span>
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
      className="inline-flex items-center gap-2"
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
