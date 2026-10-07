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
