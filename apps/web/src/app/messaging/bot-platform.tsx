'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { ReadOnly } from '@/components/read-only';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';

interface BotView {
  readonly enabled: boolean;
  readonly bot: {
    readonly name: string;
    readonly username: string;
    readonly status: 'active' | 'disabled';
    readonly last_error: string | null;
    readonly last_checked_at: string | null;
    readonly clients: number;
    readonly subscribers: number;
  } | null;
}

const KEY = ['bots', 'platform'] as const;

/**
 * Бот площадки ([ADR-0077](../../../../../docs/adr/0077-bot-max-vtoroy-kanal.md)): токен вписывает администратор,
 * бот создаётся вручную в «MAX для бизнеса». Площадка проверяет токен у MAX и сама настраивает приём событий.
 */
export function BotPlatform() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');

  const state = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => request<BotView>('/bots/platform', { signal }),
  });
  const store = (view: BotView) => queryClient.setQueryData(KEY, view);

  const register = useMutation({
    mutationFn: () => request<BotView>('/bots/platform', { method: 'PUT', body: { token } }),
    onSuccess: (view) => {
      setToken('');
      store(view);
    },
  });
  const check = useMutation({
    mutationFn: () => request<BotView>('/bots/platform/check', { method: 'POST' }),
    onSuccess: store,
  });
  const disable = useMutation({
    mutationFn: () => request<BotView>('/bots/platform/disable', { method: 'POST' }),
    onSuccess: store,
  });

  const data = state.data;
  const error = [register.error, check.error, disable.error, state.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );
  const bot = data?.bot ?? null;

  return (
    <section aria-label="Бот MAX" className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">Бот площадки</h2>
        <Hint label="Как подключить бота">
          <p>
            Создайте бота в «MAX для бизнеса» (business.max.ru) и вставьте его токен. Модерация бота
            у MAX занимает до 48 часов, токен выдаётся после неё.
          </p>
          <p className="mt-2">
            Продукт включается настройкой «Бот MAX» в «Настройках площадки». Пассажиры подписываются
            по ссылкам клиентов, а бот пишет только им.
          </p>
        </Hint>
      </div>

      {!canChange && <ReadOnly what="бота" />}
      {error !== undefined && <ErrorNote error={error} />}

      <div className="flex max-w-2xl flex-col gap-3 rounded-lg border border-border bg-card p-4">
        {bot !== null && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Бот</dt>
            <dd translate="no">
              {bot.name} <span className="num text-faint">@{bot.username}</span>
            </dd>
            <dt className="text-muted-foreground">Состояние</dt>
            <dd>
              {bot.status === 'disabled'
                ? 'Отключён'
                : bot.last_error === null
                  ? 'Работает'
                  : 'Требует внимания'}
              {data?.enabled === false && (
                <span className="text-muted-foreground"> · продукт выключен в настройках</span>
              )}
            </dd>
            {bot.last_error !== null && (
              <>
                <dt className="text-muted-foreground">Что не так</dt>
                <dd className="text-destructive">{bot.last_error}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Проверен</dt>
            <dd className="num">
              {bot.last_checked_at === null ? '—' : moment(bot.last_checked_at)}
            </dd>
            <dt className="text-muted-foreground">Клиентов / подписчиков</dt>
            <dd className="num">
              {bot.clients} / {bot.subscribers}
            </dd>
          </dl>
        )}

        {canChange && (
          <form
            className="flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (token.trim() === '' || register.isPending) return;
              register.mutate();
            }}
          >
            <Label htmlFor="bot-token">{bot === null ? 'Токен бота' : 'Заменить токен'}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="bot-token"
                type="password"
                autoComplete="off"
                className="num max-w-md"
                value={token}
                onChange={(event) => {
                  setToken(event.target.value);
                }}
              />
              <Button type="submit" disabled={token.trim() === '' || register.isPending}>
                {register.isPending ? 'Проверяем…' : bot === null ? 'Подключить' : 'Заменить'}
              </Button>
            </div>
          </form>
        )}

        {canChange && bot !== null && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={check.isPending}
              onClick={() => {
                check.mutate();
              }}
            >
              {check.isPending
                ? 'Проверяем…'
                : bot.status === 'disabled'
                  ? 'Включить снова'
                  : 'Проверить'}
            </Button>
            {bot.status === 'active' && (
              <Button
                variant="outline"
                size="sm"
                disabled={disable.isPending}
                onClick={() => {
                  disable.mutate();
                }}
              >
                Отключить
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
