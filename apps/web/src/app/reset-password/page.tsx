'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, request } from '@/lib/api';

/** Столько же требует API (`identity/schemas.ts`): отказ до отправки понятнее отказа после. */
const MIN_PASSWORD = 12;

/**
 * Новый пароль по ссылке из письма (`POST /auth/password-reset/confirm`).
 *
 * Страницы не было: ссылка из письма вела на 404, и восстановить пароль было нельзя
 * ничем (найдено 2026-09-23 вместе со ссылкой подтверждения адреса).
 */
export default function ResetPasswordPage() {
  return (
    <AuthCard title="Новый пароль">
      <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
        <Reset />
      </Suspense>
    </AuthCard>
  );
}

function Reset() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');

  const reset = useMutation({
    mutationFn: () =>
      request<undefined>('/auth/password-reset/confirm', {
        method: 'POST',
        body: { token, newPassword: password },
      }),
  });

  if (token === '') {
    return (
      <>
        <p role="alert" className="text-crit">
          В ссылке нет кода. Откройте ссылку из письма целиком — почтовая программа могла обрезать
          её при переносе строки.
        </p>
        <Link href="/forgot-password" className="font-semibold text-primary">
          Запросить новую ссылку
        </Link>
      </>
    );
  }

  if (reset.isSuccess) {
    return (
      <>
        <p className="text-ok">Пароль изменён.</p>
        <p className="text-muted-foreground">
          Все прежние входы закрыты — на других устройствах придётся войти заново.
        </p>
        <Link href="/login" className="font-semibold text-primary">
          Войти с новым паролем
        </Link>
      </>
    );
  }

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = repeat.length > 0 && repeat !== password;
  const ready = password.length >= MIN_PASSWORD && repeat === password;
  const error = reset.error instanceof ApiError ? reset.error : undefined;
  // Устаревшая ссылка — `401`, обрезанная — `400` за поле кода. Отказ за сам пароль
  // остаётся отказом за пароль: его объясняют `problems`.
  const expired =
    error !== undefined &&
    (error.status === 401 ||
      (error.status === 400 && error.problems.some((problem) => problem.startsWith('token'))));

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) reset.mutate();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Новый пароль</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          aria-describedby="password-hint"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        <span
          id="password-hint"
          className={tooShort ? 'text-xs text-crit' : 'text-xs text-muted-foreground'}
        >
          Не короче {MIN_PASSWORD} символов
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="repeat">Ещё раз</Label>
        <Input
          id="repeat"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={mismatch}
          value={repeat}
          onChange={(event) => {
            setRepeat(event.target.value);
          }}
        />
        {mismatch && <span className="text-xs text-crit">Пароли не совпадают</span>}
      </div>

      {error !== undefined && (
        <div role="alert" className="flex flex-col gap-1">
          <p className="text-crit">
            {expired
              ? 'Ссылка недействительна: она действует два часа и срабатывает один раз.'
              : error.message}
          </p>
          {!expired && error.problems.length > 0 && (
            <p className="text-muted-foreground">{error.problems.join('; ')}</p>
          )}
          {expired && (
            <Link href="/forgot-password" className="font-semibold text-primary">
              Запросить новую ссылку
            </Link>
          )}
        </div>
      )}

      <Button type="submit" disabled={!ready || reset.isPending}>
        {reset.isPending ? 'Сохраняем…' : 'Сохранить пароль'}
      </Button>
    </form>
  );
}
