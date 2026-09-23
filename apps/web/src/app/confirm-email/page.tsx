'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';
import { AuthCard } from '@/components/auth-card';
import { ApiError, request } from '@/lib/api';

/**
 * Подтверждение адреса по ссылке из письма (`POST /auth/email/confirm`,
 * [auth.md](../../../../../docs/api/auth.md)).
 *
 * Страницы не было вовсе: письмо уходило, а ссылка из него вела на 404
 * (владелец, 2026-09-23). Подтверждение идёт само при открытии — ради этого человек
 * и нажал ссылку. Сканеры ссылок в почте открывают адрес без сценариев, так что
 * за человека ссылку они не погасят.
 */
export default function ConfirmEmailPage() {
  return (
    <AuthCard title="Подтверждение адреса">
      <Suspense fallback={<p className="text-muted-foreground">Проверяем ссылку…</p>}>
        <Confirm />
      </Suspense>
    </AuthCard>
  );
}

function Confirm() {
  const token = useSearchParams().get('token') ?? '';
  // Ссылка одноразовая: второй запрос того же токена ответил бы «недействительна»
  // поверх уже показанного успеха. В разработке React вызывает эффект дважды.
  const sent = useRef(false);

  const confirm = useMutation({
    mutationFn: () =>
      request<undefined>('/auth/email/confirm', { method: 'POST', body: { token } }),
  });
  const { mutate } = confirm;

  useEffect(() => {
    if (token === '' || sent.current) return;
    sent.current = true;
    mutate();
  }, [token, mutate]);

  if (token === '') {
    return (
      <p role="alert" className="text-crit">
        В ссылке нет кода подтверждения. Откройте ссылку из письма целиком — почтовая программа
        могла обрезать её при переносе строки.
      </p>
    );
  }

  if (confirm.isSuccess) {
    return (
      <>
        <p className="text-ok">Адрес подтверждён.</p>
        <p className="text-muted-foreground">
          Доступ к кабинету откроется после проверки заявки администратором площадки — об этом
          придёт письмо.
        </p>
        <Link href="/login" className="font-semibold text-primary">
          Перейти ко входу
        </Link>
      </>
    );
  }

  if (confirm.isError) {
    // Устаревшая ссылка — `401`, обрезанная почтовой программой — `400` за код: для человека
    // это одно и то же, ссылка не работает.
    const expired =
      confirm.error instanceof ApiError &&
      (confirm.error.status === 401 || confirm.error.status === 400);
    return (
      <>
        <p role="alert" className="text-crit">
          {expired
            ? 'Ссылка недействительна: она действует сутки и срабатывает один раз.'
            : confirm.error.message}
        </p>
        <p className="text-muted-foreground">
          {expired
            ? 'Если адрес уже подтверждён — просто войдите. Иначе войдите и запросите новое письмо.'
            : 'Повторите позже, открыв ссылку из письма ещё раз.'}
        </p>
        <Link href="/login" className="font-semibold text-primary">
          Перейти ко входу
        </Link>
      </>
    );
  }

  return <p className="text-muted-foreground">Подтверждаем адрес…</p>;
}
