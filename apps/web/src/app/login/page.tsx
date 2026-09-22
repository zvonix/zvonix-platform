'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ThemeSwitch } from '@/components/theme-switch';
import { YandexCaptcha } from '@/components/yandex-captcha';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, request } from '@/lib/api';

interface CaptchaSettings {
  readonly site_key: string;
  readonly login: boolean;
}

interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly totpCode?: string;
  readonly captchaToken?: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | undefined>(undefined);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [needsTotp, setNeedsTotp] = useState(false);

  /**
   * Нужна ли капча на этой форме, решает площадка, а не кабинет.
   * Ответ открыт всем: ключ страницы публичен по устройству SmartCaptcha.
   */
  const captcha = useQuery({
    queryKey: ['auth', 'captcha'],
    queryFn: () => request<CaptchaSettings>('/auth/captcha'),
    // Недоступность этого ответа не должна закрывать вход: форма просто рисуется
    // без виджета, и решать будет сервер.
    retry: false,
    staleTime: 5 * 60_000,
  });

  const login = useMutation({
    mutationFn: (input: LoginInput) =>
      request<unknown>('/auth/login', { method: 'POST', body: input }),
    onSuccess: () => {
      // `replace`, а не `push`: возврат «назад» на форму входа после успешного
      // входа — это возврат на страницу, которой больше нет смысла.
      router.replace('/');
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.details['totp_required'] === true) setNeedsTotp(true);
      // Пройденный токен капчи одноразовый: после отказа нужен новый. Забыть токен мало —
      // виджет продолжал бы показывать «пройдено», и вторая попытка ушла бы без токена.
      setCaptchaToken(undefined);
      setCaptchaReset((value) => value + 1);
    },
  });

  // Ключ, а не признак: капча, включённая настройкой без ключей, действующей
  // не считается — форма ждала бы токен, который взять неоткуда.
  const siteKey =
    captcha.data?.login === true && captcha.data.site_key !== ''
      ? captcha.data.site_key
      : undefined;

  const error = login.error instanceof ApiError ? login.error : undefined;

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-[340px]">
        <div className="flex items-baseline pb-4">
          <span className="text-[17px] font-semibold tracking-tight">Zvonix</span>
          <span className="ml-auto">
            <ThemeSwitch />
          </span>
        </div>

        <form
          onSubmit={(event) => {
            // Отправку перехватываем: поля без `name`, и родная отправка формы
            // ушла бы запросом `GET` с пустой строкой запроса.
            event.preventDefault();
            // Код приходит из аутентификатора группами — «123 456», — и так же вставляется.
            // Пробелы убираются здесь: API принимает только цифры подряд.
            const code = totpCode.replace(/\s/gu, '');
            login.mutate({
              email,
              password,
              ...(needsTotp && code !== '' ? { totpCode: code } : {}),
              ...(captchaToken === undefined ? {} : { captchaToken }),
            });
          }}
          className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
        >
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

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Пароль</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          </div>

          {needsTotp && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="totp">Код из приложения</Label>
              {/*
                Без `maxLength`: «123 456» — семь знаков, и поле с пределом в шесть обрезало
                вставленный код до «123 45» (ui-review, 2026-09-14).
              */}
              <Input
                id="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                spellCheck={false}
                className="num"
                value={totpCode}
                onChange={(event) => {
                  setTotpCode(event.target.value);
                }}
              />
            </div>
          )}

          {siteKey !== undefined && (
            <YandexCaptcha siteKey={siteKey} onToken={setCaptchaToken} resetSignal={captchaReset} />
          )}

          {error !== undefined && (
            <p role="alert" className="text-crit">
              {error.message}
              {error.problems.length > 0 && (
                <span className="block text-muted-foreground">{error.problems.join('; ')}</span>
              )}
            </p>
          )}

          <Button type="submit" disabled={login.isPending}>
            {login.isPending ? 'Проверяем…' : 'Войти'}
          </Button>
        </form>
      </div>
    </div>
  );
}
