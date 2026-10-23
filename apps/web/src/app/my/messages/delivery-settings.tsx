'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MESSAGE_WAIT_MINUTES_MAX, type MessageBusyMode } from '@zvonix/shared';
import { useEffect, useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { integerFromInput } from '@/lib/money';

interface Delivery {
  readonly busy_mode: MessageBusyMode | null;
  readonly max_wait_minutes: number | null;
}

const KEY = ['client', 'messages', 'delivery'] as const;

const MODES: readonly (readonly [MessageBusyMode | null, string])[] = [
  [null, 'По умолчанию'],
  ['reject', 'Отказать сразу'],
  ['wait', 'Ждать'],
];

/**
 * «Если отправить сразу нельзя» и «сколько ждать» ([ADR-0097](../../../../../../docs/adr/0097-zanyato-i-srok-soobshcheniya.md)):
 * все аккаунты заняты — отказать сразу (программа уйдёт к другому агрегатору) или ждать в очереди до срока.
 */
export function DeliverySettings() {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) =>
      request<{ delivery: Delivery; platform_max_wait_minutes: number }>(
        '/client/messages/delivery',
        { signal },
      ),
  });
  const saved = state.data?.delivery;
  const [mode, setMode] = useState<MessageBusyMode | null>(null);
  const [wait, setWait] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (saved === undefined) return;
    setMode(saved.busy_mode);
    setWait(saved.max_wait_minutes === null ? '' : String(saved.max_wait_minutes));
  }, [saved]);

  const parsed = wait.trim() === '' ? null : integerFromInput(wait.trim());
  const waitValid =
    parsed === null || (parsed !== undefined && parsed >= 1 && parsed <= MESSAGE_WAIT_MINUTES_MAX);

  const save = useMutation({
    mutationFn: () =>
      request<unknown>('/client/messages/delivery', {
        method: 'PUT',
        body: { busyMode: mode, maxWaitMinutes: parsed ?? null },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KEY });
      setDone(true);
    },
  });

  if (state.data === undefined) return null;
  const platformWait = state.data.platform_max_wait_minutes;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">Если отправить сразу нельзя</h2>
        <Hint label="Что значит «отправить сразу нельзя»">
          <p>
            Только про ожидание <b>до отправки</b>. У аккаунта есть паузы между сообщениями и
            пределы в минуту и в час — защита от блокировки. Пришло сообщение, а все подходящие
            аккаунты на паузе:
          </p>
          <p className="mt-2">
            «Отказать сразу» — программа в ту же секунду получает отказ, денег не списано, и она
            может сразу отправить SMS через другого агрегатора. Для такси — так лучше.
          </p>
          <p className="mt-2">
            «Ждать» — сообщение встаёт в очередь и уходит, когда аккаунт освободится; не ушло за это
            время — отчёт «истёк срок», деньги возвращаются.
          </p>
          <p className="mt-2">
            Ответ MAX «доставлено» эта настройка не ограничивает: он приходит, как только MAX его
            пришлёт.
          </p>
          <p className="mt-2">
            По умолчанию: по SMPP — отказать сразу, через API и кабинет — ждать. Если программа
            передаёт срок сообщения (validity period), действует меньший срок.
          </p>
        </Hint>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div
          role="group"
          aria-label="Если отправить сразу нельзя"
          className="flex rounded-md border border-border p-0.5"
        >
          {MODES.map(([value, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
                setDone(false);
              }}
              className={`rounded px-2.5 py-1 text-sm ${
                mode === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Сколько ждать, минут</span>
          <Input
            className="num w-32"
            inputMode="numeric"
            placeholder={String(platformWait)}
            aria-invalid={!waitValid}
            // «Отказать сразу» не ждёт вовсе — поле не на что влиять (владелец видел «1 минуту» рядом с отказом).
            disabled={mode === 'reject'}
            title={mode === 'reject' ? 'При «Отказать сразу» сообщение не ждёт' : undefined}
            value={wait}
            onChange={(event) => {
              setWait(event.target.value);
              setDone(false);
            }}
          />
        </label>
        <Button
          type="button"
          variant="outline"
          disabled={!waitValid || save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          {save.isPending ? 'Сохраняем…' : 'Сохранить'}
        </Button>
        {done && (
          <span role="status" className="text-ok">
            Сохранено
          </span>
        )}
      </div>
      {!waitValid && (
        <p className="text-warn">
          Целое число минут от 1 до {String(MESSAGE_WAIT_MINUTES_MAX)} или пусто.
        </p>
      )}
      {save.error instanceof ApiError && <ErrorNote error={save.error} />}
      {state.error instanceof ApiError && <ErrorNote error={state.error} />}
    </section>
  );
}
