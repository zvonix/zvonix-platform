'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { ApiError, request } from '@/lib/api';

interface BotState {
  readonly available: boolean;
  readonly connection: { readonly enabled: boolean; readonly link: string } | null;
  readonly subscribers: { readonly total: number; readonly with_phone: number };
}

const KEY = ['client', 'messages', 'bot'] as const;

/**
 * Бот MAX клиента ([ADR-0077](../../../../../../docs/adr/0077-bot-max-vtoroy-kanal.md)): ссылка, по которой
 * пассажиры подписываются на уведомления, и сколько их подписалось. Пока бот площадки не вписан — блока нет.
 */
export function BotConnection() {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);

  const state = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => request<BotState>('/client/messages/bot', { signal }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });

  const connect = useMutation({
    mutationFn: () => request<BotState>('/client/messages/bot', { method: 'POST' }),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      request<BotState>('/client/messages/bot', { method: 'PATCH', body: { enabled } }),
    onSuccess: refresh,
  });

  const data = state.data;
  if (data === undefined || !data.available) return null;

  const { connection, subscribers } = data;
  const error = [connect.error, toggle.error, state.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );

  return (
    <section className="flex max-w-2xl flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">Бот MAX</h2>
        <Hint label="Как работает бот">
          <p>
            Пассажир открывает вашу ссылку, нажимает «Запустить» и делится номером. После этого
            сообщения на его номер уходят от бота, а не с личного аккаунта.
          </p>
          <p className="mt-2">
            Бот пишет только тем, кто подписался по вашей ссылке. Остальным сообщения идут как
            обычно.
          </p>
        </Hint>
      </div>

      {connection === null ? (
        <div>
          <Button
            disabled={connect.isPending}
            onClick={() => {
              connect.mutate();
            }}
          >
            {connect.isPending ? 'Подключаем…' : 'Подключить бота'}
          </Button>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Ссылка для пассажиров</dt>
            <dd className="num select-all break-all" translate="no">
              {connection.link}
            </dd>
            <dt className="text-muted-foreground">Подписчиков</dt>
            <dd className="num">
              {subscribers.total}, с номером — {subscribers.with_phone}
            </dd>
          </dl>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard
                  .writeText(connection.link)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => {
                      setCopied(false);
                    }, 2000);
                  })
                  .catch(() => undefined);
              }}
            >
              {copied ? 'Скопировано' : 'Копировать ссылку'}
            </Button>
            {connection.enabled ? (
              <Button
                variant="outline"
                size="sm"
                disabled={toggle.isPending}
                onClick={() => {
                  toggle.mutate(false);
                }}
              >
                Отключить
              </Button>
            ) : (
              <>
                <span className="rounded-md bg-warn-soft px-2 py-0.5 text-warn">Отключено</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={toggle.isPending}
                  onClick={() => {
                    toggle.mutate(true);
                  }}
                >
                  Включить
                </Button>
              </>
            )}
          </div>
        </>
      )}

      {error !== undefined && <ErrorNote error={error} />}
    </section>
  );
}
