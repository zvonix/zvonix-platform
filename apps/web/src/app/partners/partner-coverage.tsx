'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';

interface Coverage {
  readonly region: string;
  readonly region_key: string;
}

/**
 * Регионы, которые партнёр берётся обслуживать
 * ([ADR-0022](../../../../../docs/adr/0022-pokrytie-regionov.md)).
 *
 * Список закрытый, и **пустой означает «все регионы»**, а не «никакие»: партнёр без
 * объявленного покрытия берёт любой номер. Закрыть его целиком можно состоянием,
 * а не пустым списком.
 *
 * Рядом с названием показывается приведённый ключ: по нему видно, во что превратилось
 * написание, и почему `Красноярский кр.` и `Красноярский край` — один регион.
 * Разбор «партнёр объявил, а вызовов нет» начинается именно отсюда.
 */
export function PartnerCoverage({ partnerId }: { partnerId: string }) {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState('');

  const list = useQuery({
    queryKey: ['coverage', partnerId],
    queryFn: () => request<{ regions: Coverage[] }>(`/partners/${partnerId}/coverage`),
  });

  const save = useMutation({
    mutationFn: (regions: string[]) =>
      request<unknown>(`/partners/${partnerId}/coverage`, {
        method: 'PUT',
        body: { regions },
      }),
    onSuccess: async () => {
      setAdding('');
      await queryClient.invalidateQueries({ queryKey: ['coverage', partnerId] });
    },
  });

  const regions = list.data?.regions ?? [];
  const names = regions.map((row) => row.region);
  const failed = [list.error, save.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold">Покрытие по регионам</h3>

      <p className="text-muted-foreground">
        {regions.length === 0
          ? 'Список пуст — партнёр берёт номера любого региона.'
          : 'Партнёр берёт номера только этих регионов. Пустой список означал бы «все».'}
      </p>

      {canChange && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = adding.trim();
            if (value.length >= 2 && !names.includes(value)) save.mutate([...names, value]);
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Добавить регион</span>
            <Input
              className="w-[260px]"
              value={adding}
              placeholder="Республика Татарстан"
              onChange={(event) => {
                setAdding(event.target.value);
              }}
            />
          </label>
          <Button type="submit" variant="outline" size="sm" disabled={save.isPending}>
            Добавить
          </Button>
        </form>
      )}

      {failed !== undefined && (
        <p role="alert" className="text-crit">
          {failed.message}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {regions.map((row) => (
          <span
            key={row.region_key}
            className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1"
          >
            <span>
              {row.region}
              <span className="num block text-faint">{row.region_key}</span>
            </span>
            {canChange && (
              <button
                type="button"
                aria-label={`Убрать ${row.region}`}
                disabled={save.isPending}
                onClick={() => {
                  save.mutate(names.filter((name) => name !== row.region));
                }}
                className="text-muted-foreground hover:text-crit disabled:opacity-50"
              >
                ✕
              </button>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
