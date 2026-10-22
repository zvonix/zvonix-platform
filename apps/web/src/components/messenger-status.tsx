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
      <span className={`rounded-md px-2 py-0.5 ${messengerAccountTone(status)}`}>{name}</span>
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
 * «Пауза до 16:42 — лимит в час», ниже «через 12 мин»: аккаунт работает, но сейчас сообщений не берёт (владелец, 2026-10-22).
 * Окна лимитов скользящие — время посчитано сервером по самому раннему сообщению в окне.
 */
export function AccountRestNote({ rest }: { rest: AccountRest }) {
  if (rest === null || rest === undefined) return null;
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
    <span className="mt-1 block text-warn">
      Пауза до <span className="num">{time}</span> — {REST_NAME[rest.reason]}
      <span className="block text-xs text-muted-foreground">{left}</span>
    </span>
  );
}
