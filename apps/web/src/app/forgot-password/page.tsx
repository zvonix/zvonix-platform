'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { YandexCaptcha } from '@/components/yandex-captcha';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, request } from '@/lib/api';

interface CaptchaSettings {
  readonly site_key: string;
  readonly password_reset: boolean;
}

/**
 * Запрос ссылки для нового пароля (`POST /auth/password-reset`).
 *
 * Ответ один и тот же, есть такой адрес или нет: иначе по нему перебирали бы адреса
 * ([auth.md](../../../../../docs/api/auth.md)). Поэтому и экран после отправки говорит
 * «если адрес зарегистрирован», а не «письмо ушло».
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | undefined>(undefined);
  const [captchaReset, setCaptchaReset] = useState(0);

  const captcha = useQuery({
    queryKey: ['auth', 'captcha'],
    queryFn: () => request<CaptchaSettings>('/auth/captcha'),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const siteKey =
    captcha.data?.password_reset === true && captcha.data.site_key !== ''
      ? captcha.data.site_key
      : undefined;

  const send = useMutation({
    mutationFn: () =>
      request<undefined>('/auth/password-reset', {
        method: 'POST',
        body: { email, ...(captchaToken === undefined ? {} : { captchaToken }) },
      }),
    onError: () => {
      // Токен капчи одноразовый: после отказа нужен новый.
      setCaptchaToken(undefined);
      setCaptchaReset((value) => value + 1);
    },
  });

  if (send.isSuccess) {
    return (
      <AuthCard title="Проверьте почту">
        <p>
          Если адрес <b>{email}</b> зарегистрирован, на него ушло письмо со ссылкой для нового
          пароля. Ссылка действует два часа и срабатывает один раз.
        </p>
        <p className="text-muted-foreground">
          Письма нет несколько минут — проверьте папку «Спам» и адрес. Новая заявка гасит прежнюю
          ссылку.
        </p>
        <Link href="/login" className="font-semibold text-primary">
          Вернуться ко входу
        </Link>
      </AuthCard>
    );
  }

  const error = send.error instanceof ApiError ? send.error : undefined;

  return (
    <AuthCard title="Восстановление пароля">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          send.mutate();
        }}
      >
        <p className="text-muted-foreground">
          Укажите адрес, с которым входите. Пришлём ссылку, по которой можно задать новый пароль.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Адрес почты</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            spellCheck={false}
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </div>

        {siteKey !== undefined && (
          <YandexCaptcha siteKey={siteKey} onToken={setCaptchaToken} resetSignal={captchaReset} />
        )}

        {error !== undefined && (
          <p role="alert" className="text-crit">
            {error.message}
          </p>
        )}

        <Button type="submit" disabled={send.isPending}>
          {send.isPending ? 'Отправляем…' : 'Прислать ссылку'}
        </Button>
        <Link href="/login" className="text-center text-muted-foreground hover:text-foreground">
          Вспомнили пароль — ко входу
        </Link>
      </form>
    </AuthCard>
  );
}
