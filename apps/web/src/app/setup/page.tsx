'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ThemeSwitch } from '@/components/theme-switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, request } from '@/lib/api';

interface FirstRunInput {
  readonly code: string;
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
}

/**
 * Первый запуск: первый администратор по коду из вывода выкладки
 * ([ADR-0050](../../../../../docs/adr/0050-ustanovka-odnoy-komandoy-i-pervyy-vhod.md)).
 *
 * Страница открыта всем, но без кода ничего не заводит: код видит только тот, кто
 * запускал установку. Как только администратор есть, она говорит «уже выполнен»
 * и ведёт на вход.
 */
export default function SetupPage() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [mismatch, setMismatch] = useState(false);

  const state = useQuery({
    queryKey: ['setup'],
    queryFn: () => request<{ required: boolean }>('/setup'),
    retry: false,
  });

  const complete = useMutation({
    mutationFn: (input: FirstRunInput) =>
      request<unknown>('/setup', { method: 'POST', body: input }),
    onSuccess: () => {
      // Кэш «первый запуск нужен» переписывается сразу: иначе вход, куда ведёт кнопка ниже,
      // прочёл бы старый ответ и вернул человека сюда же.
      queryClient.setQueryData(['setup'], { required: false });
    },
    onError: async (error: unknown) => {
      // «Уже выполнен» — не ошибка формы, а смена состояния площадки: перечитываем его,
      // и страница сама покажет вход.
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ['setup'] });
      }
    },
  });

  const error = complete.error instanceof ApiError ? complete.error : undefined;

  let body;
  if (complete.isSuccess) {
    body = (
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <p>Администратор создан. Войдите с этим адресом и паролем.</p>
        <Button asChild>
          <Link href="/login">Войти</Link>
        </Button>
      </div>
    );
  } else if (state.data?.required === false) {
    body = (
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <p>Первый запуск уже выполнен: администратор на площадке есть.</p>
        <Button asChild variant="outline">
          <Link href="/login">Ко входу</Link>
        </Button>
      </div>
    );
  } else if (state.isError) {
    body = (
      <p role="alert" className="text-crit">
        Площадка не ответила, нужен ли первый запуск. Обновите страницу чуть позже.
      </p>
    );
  } else {
    body = (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (password !== repeat) {
            setMismatch(true);
            return;
          }
          complete.mutate({ code, email, fullName, password });
        }}
        className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
      >
        <p className="text-muted-foreground">
          Администратора ещё нет. Код напечатала выкладка на сервере — строка «Код» в её выводе.
        </p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code">Код первого запуска</Label>
          <Input
            id="code"
            autoComplete="off"
            spellCheck={false}
            className="num"
            placeholder="XXXX-XXXX-XXXX"
            required
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Адрес почты администратора</Label>
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
          <Label htmlFor="full-name">Имя</Label>
          <Input
            id="full-name"
            autoComplete="name"
            required
            value={fullName}
            onChange={(event) => {
              setFullName(event.target.value);
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Пароль — не короче 12 знаков</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setMismatch(false);
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password-repeat">Пароль ещё раз</Label>
          {/*
            Повтор пароля здесь нужен, хотя у входа его нет: опечатка в пароле единственного
            администратора запирает площадку — восстановить его без почты нечем.
          */}
          <Input
            id="password-repeat"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={mismatch}
            aria-describedby={mismatch ? 'password-repeat-error' : undefined}
            value={repeat}
            onChange={(event) => {
              setRepeat(event.target.value);
              setMismatch(false);
            }}
          />
          {mismatch && (
            <p id="password-repeat-error" role="alert" className="text-crit">
              Пароли не совпадают — наберите их заново.
            </p>
          )}
        </div>

        {error !== undefined && (
          <p role="alert" className="text-crit">
            {error.message}
            {error.problems.length > 0 && (
              <span className="block text-muted-foreground">{error.problems.join('; ')}</span>
            )}
          </p>
        )}

        <Button type="submit" disabled={complete.isPending || state.isPending}>
          {complete.isPending ? 'Создаём…' : 'Создать администратора'}
        </Button>
      </form>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-[380px]">
        <div className="flex items-baseline pb-4">
          <span className="text-[17px] font-semibold tracking-tight">Zvonix · первый запуск</span>
          <span className="ml-auto">
            <ThemeSwitch />
          </span>
        </div>
        {body}
      </div>
    </div>
  );
}
