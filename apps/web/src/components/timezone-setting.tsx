'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { ApiError, request } from '@/lib/api';
import { otherTimezones, RUSSIAN_TIMEZONES, timezoneLabel } from '@/lib/timezones';

/**
 * Часовой пояс аккаунта ([ADR-0102](../../../../docs/adr/0102-chasovoy-poyas-akkaunta-i-limity.md)): в нём
 * считаются сутки, недели и месяцы лимитов. Набранное за текущие сутки при смене сохраняется — API переносит его.
 */
export function TimezoneSetting({
  current,
  endpoint,
  invalidate,
}: {
  /** Пусто — не выбран: лимиты считаются по UTC. */
  current: string | null;
  endpoint: string;
  invalidate: readonly (readonly string[])[];
}) {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState(current ?? '');
  const save = useMutation({
    mutationFn: (timezone: string) => request(endpoint, { method: 'PUT', body: { timezone } }),
    onSuccess: async () => {
      await Promise.all(
        invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey: [...queryKey] })),
      );
    },
  });
  const error = save.error instanceof ApiError ? save.error : undefined;

  return (
    <section className="flex max-w-xl flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-semibold">Часовой пояс</h2>
      <p className="text-muted-foreground">
        {current === null
          ? 'Не выбран — сутки лимитов начинаются в 03:00 по Москве.'
          : `Сутки лимитов начинаются в 00:00 · ${timezoneLabel(current)}.`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Часовой пояс"
          value={choice}
          onChange={(event) => {
            setChoice(event.target.value);
          }}
          className="h-9 min-w-0 max-w-full rounded-md border border-input bg-transparent px-2"
        >
          {current === null && <option value="">Не выбран</option>}
          <optgroup label="Россия">
            {RUSSIAN_TIMEZONES.map((zone) => (
              <option key={zone.id} value={zone.id}>
                {zone.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Другие страны">
            {otherTimezones().map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll('_', ' ')}
              </option>
            ))}
          </optgroup>
        </select>
        <Button
          size="sm"
          disabled={choice === '' || choice === current || save.isPending}
          onClick={() => {
            save.mutate(choice);
          }}
        >
          Сохранить
        </Button>
      </div>
      {error !== undefined && <ErrorNote error={error} />}
    </section>
  );
}
