'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';

const KEY = 'messages.markup_percent';
const SETTINGS_QUERY_KEY = ['settings'] as const;

interface SettingsResponse {
  readonly settings: readonly {
    readonly key: string;
    readonly value: string | number | boolean | null;
  }[];
}

/**
 * Наценка площадки на сообщения MAX — одно число в процентах на весь продукт.
 *
 * Лежит здесь, рядом с наценкой на звонки, чтобы вся наценка площадки была на одной странице. Хранится
 * по-прежнему в настройках площадки (`messages.markup_percent`): у числа один источник. Поддержке настройки
 * закрыты, поэтому раздел рисуется только администратору.
 */
export function MessageMarkup() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState<string | undefined>(undefined);

  const settings = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => request<SettingsResponse>('/settings'),
    enabled: canChange,
  });

  const save = useMutation({
    mutationFn: (value: number) =>
      request<SettingsResponse>('/settings', {
        method: 'PUT',
        body: { settings: { [KEY]: value } },
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, response);
      setTyped(undefined);
    },
  });

  if (!canChange) return null;
  const stored = settings.data?.settings.find((setting) => setting.key === KEY)?.value;
  if (stored === undefined || stored === null) {
    return settings.error instanceof ApiError ? <ErrorNote error={settings.error} /> : null;
  }

  const text = typed ?? String(stored);
  const parsed = Number(text.replace(',', '.'));
  const valid = text.trim() !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000;
  const failure = save.error instanceof ApiError ? save.error : undefined;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold">Наценка на сообщения MAX</h2>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !save.isPending) save.mutate(parsed);
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="message-markup">Процент к цене партнёра за сообщение</Label>
          <Input
            id="message-markup"
            className="num max-w-32"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            aria-invalid={!valid}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={!valid || typed === undefined || save.isPending}
        >
          {save.isPending ? 'Сохраняем…' : 'Сохранить'}
        </Button>
      </form>
      {failure !== undefined && <ErrorNote error={failure} />}
    </section>
  );
}
