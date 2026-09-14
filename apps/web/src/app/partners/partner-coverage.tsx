'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';

interface Coverage {
  readonly region: string;
  readonly region_key: string;
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

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
 *
 * **Менять можно только загруженный список.** Обработчик заменяет список целиком, и форма,
 * работавшая до ответа, отправляла `[новый регион]` — стирая все прежние. Пока шёл запрос,
 * экран к тому же писал «список пуст — берёт любой регион» (ui-review, 2026-09-14).
 */
export function PartnerCoverage({ partnerId }: { partnerId: string }) {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState('');

  const list = useQuery({
    queryKey: ['coverage', partnerId],
    queryFn: () => request<{ regions: Coverage[] }>(`/partners/${partnerId}/coverage`),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['coverage', partnerId] });
  };

  const save = useMutation({
    mutationFn: (regions: string[]) =>
      request<unknown>(`/partners/${partnerId}/coverage`, {
        method: 'PUT',
        body: { regions },
      }),
    onSuccess: refresh,
  });

  // Опустошение списка — отдельное действие со своим подтверждением: оно не сужает,
  // а расширяет покрытие до всех регионов. Отказ показывается в окне подтверждения.
  const clear = useMutation({
    mutationFn: () =>
      request<unknown>(`/partners/${partnerId}/coverage`, {
        method: 'PUT',
        body: { regions: [] },
      }),
    onSuccess: () => {
      void refresh();
    },
  });

  const loaded = list.isSuccess;
  const regions = list.data?.regions ?? [];
  const names = regions.map((row) => row.region);
  const listError = asApiError(list.error);
  const saveError = asApiError(save.error);
  const busy = save.isPending || clear.isPending;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold">Покрытие по регионам</h3>

      {list.isPending && <p className="text-muted-foreground">Загружаем покрытие…</p>}
      {listError !== undefined && <ErrorNote error={listError} />}
      {loaded && (
        <p className="text-muted-foreground">
          {regions.length === 0
            ? 'Список пуст — партнёр берёт номера любого региона.'
            : 'Партнёр берёт номера только этих регионов. Пустой список означал бы «все».'}
        </p>
      )}

      {canChange && loaded && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = adding.trim();
            if (value.length < 2 || names.includes(value)) return;
            // Поле чистится только после добавления: удаление соседнего региона идёт той же
            // мутацией и стирало набранное.
            save.mutate([...names, value], {
              onSuccess: () => {
                setAdding('');
              },
            });
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Добавить регион</span>
            <Input
              className="w-[260px]"
              value={adding}
              autoComplete="off"
              placeholder="Республика Татарстан"
              onChange={(event) => {
                setAdding(event.target.value);
              }}
            />
          </label>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={busy || adding.trim().length < 2 || names.includes(adding.trim())}
          >
            Добавить
          </Button>
          {names.includes(adding.trim()) && (
            <p className="w-full text-warn">Этот регион уже в списке.</p>
          )}
        </form>
      )}

      {saveError !== undefined && <ErrorNote error={saveError} />}

      <div className="flex flex-wrap gap-2">
        {regions.map((row) => (
          <span
            key={row.region_key}
            className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1"
          >
            <span>
              {row.region}
              <span className="num block text-faint" translate="no">
                {row.region_key}
              </span>
            </span>
            {canChange &&
              (regions.length === 1 ? (
                <ConfirmAction
                  label="Убрать"
                  size="xs"
                  title={`Убрать последний регион «${row.region}»`}
                  consequence={
                    <p>
                      Список станет пустым, а пустой список означает «все регионы»: партнёр начнёт
                      получать номера любого региона, а не только этого.
                    </p>
                  }
                  confirmLabel="Убрать и открыть все регионы"
                  disabled={busy}
                  onConfirm={() => clear.mutateAsync()}
                />
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={() => {
                    save.mutate(names.filter((name) => name !== row.region));
                  }}
                >
                  Убрать
                </Button>
              ))}
          </span>
        ))}
      </div>
    </div>
  );
}
