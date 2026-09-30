'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { Cabinet } from '@zvonix/shared';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { ThemeSwitch } from '@/components/theme-switch';
import { YandexCaptcha } from '@/components/yandex-captcha';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, request } from '@/lib/api';

interface CaptchaSettings {
  readonly site_key: string;
  readonly register: boolean;
}

/**
 * Что говорит левая колонка. Текст зависит от выбора: клиенту и партнёру площадка
 * обещает разное. Про проверку администратором ничего не сказано: допуск зависит
 * от настроек площадки (`clients.auto_approve`, `partners.auto_approve`).
 */
const PITCH: Record<Cabinet, { title: string; text: string; steps: readonly string[] }> = {
  client: {
    title: 'Звонки через SIM-карты — дешевле и без сбоев',
    text: 'Звонки идут через SIM-карты партнёров, а получатель видит мобильный номер, а не городской.',
    steps: ['Подтвердите почту', 'Пополните счёт', 'Каждый звонок и каждое списание — в отчёте'],
  },
  partner: {
    title: 'Ваши SIM звонят — вы получаете деньги',
    text: 'Подключите GOIP с SIM-картами: площадка направит на них звонки клиентов. Цену назначаете вы, заработок виден по каждой карте.',
    steps: [
      'Подтвердите почту',
      'Шлюз подключается по инструкции из кабинета',
      'По каждому звонку — отчёт и заработок',
    ],
  },
};

const ROLES: readonly { id: Cabinet; title: string; text: string }[] = [
  { id: 'client', title: 'Клиент', text: 'Хочу звонить через площадку' },
  { id: 'partner', title: 'Партнёр', text: 'Есть SIM и GOIP — хочу зарабатывать на звонках' },
];

/**
 * Регистрация: учётная запись участника и первая заявка на кабинет одной формой
 * ([ADR-0052](../../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)).
 *
 * Ответ API одинаков и для нового адреса, и для занятого (ADR-0029), поэтому и экран
 * после отправки один: «проверьте почту». Что адрес занят, человек узнаёт письмом.
 */
export default function RegisterPage() {
  const [cabinet, setCabinet] = useState<Cabinet>('client');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | undefined>(undefined);
  const [captchaReset, setCaptchaReset] = useState(0);

  const captcha = useQuery({
    queryKey: ['auth', 'captcha'],
    queryFn: () => request<CaptchaSettings>('/auth/captcha'),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const siteKey =
    captcha.data?.register === true && captcha.data.site_key !== ''
      ? captcha.data.site_key
      : undefined;

  const register = useMutation({
    mutationFn: () =>
      request<undefined>('/auth/register', {
        method: 'POST',
        body: {
          email,
          password,
          fullName,
          // Анкеты нет: клиент — не только такси, а спрашивать телефон незачем (владелец, 2026-09-30).
          cabinet,
          answers: {},
          ...(captchaToken === undefined ? {} : { captchaToken }),
        },
      }),
    onError: () => {
      // Пройденный токен капчи одноразовый: после отказа нужен новый.
      setCaptchaToken(undefined);
      setCaptchaReset((value) => value + 1);
    },
  });

  const pitch = PITCH[cabinet];
  const error = register.error instanceof ApiError ? register.error : undefined;

  return (
    <div className="grid min-h-dvh md:grid-cols-[minmax(320px,480px)_1fr]">
      <aside className="flex flex-col gap-6 bg-rail px-6 py-8 text-rail-ink md:px-12 md:py-12">
        <span className="text-xl font-semibold tracking-tight text-white">Zvonix</span>
        <h1 className="text-3xl leading-tight font-semibold text-balance text-white md:mt-6 md:text-4xl">
          {pitch.title}
        </h1>
        <p className="max-w-[42ch] text-[15px] leading-relaxed">{pitch.text}</p>
        {/* Порядок — настоящий: сначала проверка, потом подключение, потом работа. */}
        <ol className="flex flex-col gap-3">
          {pitch.steps.map((step, index) => (
            <li key={step} className="grid grid-cols-[28px_1fr] gap-2">
              <span className="num text-primary">{String(index + 1).padStart(2, '0')}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <span className="mt-auto hidden text-sm text-rail-ink-dim md:block">
          Ответ по заявке придёт на почту.
        </span>
      </aside>

      <main className="flex justify-center px-4 py-8 md:px-12 md:py-12">
        {register.isSuccess ? (
          <section role="status" className="flex w-full max-w-[560px] flex-col gap-3">
            <h2 className="text-2xl font-semibold">Заявка отправлена</h2>
            <p>
              Проверьте почту <b>{email}</b>: подтвердите адрес по ссылке из письма. Заявку
              рассмотрит администратор площадки, и войти можно будет после одобрения — о нём тоже
              придёт письмо.
            </p>
            <Link href="/login" className="font-semibold text-primary">
              На страницу входа
            </Link>
          </section>
        ) : (
          <form
            className="flex w-full max-w-[560px] flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              register.mutate();
            }}
          >
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="text-2xl font-semibold">Заявка на подключение</h2>
              <span className="ml-auto flex items-center gap-3">
                <Link href="/login" className="text-sm font-semibold text-primary">
                  Уже есть вход? Войти
                </Link>
                <ThemeSwitch />
              </span>
            </div>

            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="pb-2 font-medium">Кто вы</legend>
              {ROLES.map((role) => {
                const on = role.id === cabinet;
                return (
                  <button
                    key={role.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      setCabinet(role.id);
                    }}
                    className={
                      on
                        ? 'flex min-h-[76px] flex-col items-start gap-1 rounded-lg border-2 border-primary bg-primary/10 px-4 py-3 text-left'
                        : 'flex min-h-[76px] flex-col items-start gap-1 rounded-lg border border-border bg-card px-4 py-3 text-left hover:border-foreground/30'
                    }
                  >
                    <span className="font-semibold">{role.title}</span>
                    <span className="text-sm text-muted-foreground">{role.text}</span>
                  </button>
                );
              })}
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="fullName">Ваше имя</Label>
                <Input
                  id="fullName"
                  autoComplete="name"
                  required
                  value={fullName}
                  onChange={(event) => {
                    setFullName(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Почта — она же логин</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
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
                  autoComplete="new-password"
                  minLength={12}
                  required
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                  }}
                />
                <span className="text-xs text-muted-foreground">Не короче 12 символов</span>
              </div>
            </div>

            {siteKey !== undefined && (
              <YandexCaptcha
                siteKey={siteKey}
                onToken={setCaptchaToken}
                resetSignal={captchaReset}
              />
            )}

            <label className="flex items-start gap-2.5 text-sm text-muted-foreground">
              <input
                type="checkbox"
                required
                checked={consent}
                onChange={(event) => {
                  setConsent(event.target.checked);
                }}
                className="mt-0.5 size-4 accent-primary"
              />
              <span>Согласен на обработку моих данных для рассмотрения заявки</span>
            </label>

            {error !== undefined && <ErrorNote error={error} />}

            <Button type="submit" size="default" disabled={register.isPending} className="h-11">
              {register.isPending ? 'Отправляем…' : 'Отправить заявку'}
            </Button>
            <p className="text-sm text-muted-foreground">
              Войти можно будет после одобрения. Второй кабинет — клиента или партнёра — потом
              подключается из первого, тем же логином.
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
