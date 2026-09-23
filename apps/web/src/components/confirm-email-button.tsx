'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ConfirmAction } from '@/components/confirm-action';
import { request } from '@/lib/api';

/**
 * Подтвердить адрес за человека (`POST /users/:id/email/confirm`) — когда письмо
 * не доходит, а адрес проверен иначе (владелец, 2026-09-23).
 *
 * Через подтверждение с последствием: без подтверждённого адреса вход не открывается
 * и заявка не одобряется, и эта кнопка снимает защиту. Обновляет и заявки, и учётные
 * записи — признак виден в обоих списках.
 */
export function ConfirmEmailButton({ userId, email }: { userId: string; email: string }) {
  const queryClient = useQueryClient();

  return (
    <ConfirmAction
      label="Подтвердить почту"
      title={`Подтвердить адрес ${email} вручную`}
      consequence={
        <>
          <p>
            Подтверждайте, только если убедились, что адрес принадлежит этому человеку: например,
            позвонили по номеру из заявки. Иначе вход получит тот, кто вписал чужой адрес.
          </p>
          <p>Действие попадёт в журнал с вашим именем.</p>
        </>
      }
      confirmLabel="Подтвердить адрес"
      tone="neutral"
      size="xs"
      onConfirm={async () => {
        await request<unknown>(`/users/${userId}/email/confirm`, { method: 'POST' });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['applications'] }),
          queryClient.invalidateQueries({ queryKey: ['users'] }),
        ]);
      }}
    />
  );
}
