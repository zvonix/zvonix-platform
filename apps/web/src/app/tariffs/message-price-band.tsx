'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { DialogField, FormDialog } from '@/components/form-dialog';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { bandRange, microunits, moneyFromInput } from '@/lib/money';

interface MessageBand {
  readonly id: string;
  readonly min_price: string | null;
  readonly max_price: string | null;
  readonly effective_from: string;
}

const QUERY_KEY = ['price-bands', 'message'] as const;

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/**
 * Коридор цены сообщения ([ADR-0023](../../../../../docs/adr/0023-koridory-cen.md), ревизия 2026-10-16).
 *
 * Как у звонков: рамка на цену, которую партнёр назначает в своём тарифе MAX. Отличий два: у сообщения одна цена
 * (направлений нет — ни оператора, ни региона) и границы — цена **за одно сообщение**. Коридор один на всё:
 * «Изменить» заменяет границы, «Снять» открывает цену партнёрам; одну из границ можно не задавать.
 */
export function MessagePriceBand() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const list = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => request<{ bands: MessageBand[] }>('/price-bands?product=message'),
  });
  const listError = asApiError(list.error);
  // Свежие сверху: первый из начавших действовать — действующий; снятый (обе границы пусты) коридора не оставляет.
  const now = Date.now();
  const latest = list.data?.bands.find((band) => new Date(band.effective_from).getTime() <= now);
  const band =
    latest !== undefined && (latest.min_price !== null || latest.max_price !== null)
      ? latest
      : undefined;

  const lift = useMutation({
    mutationFn: () =>
      request<unknown>('/price-bands', {
        method: 'POST',
        body: { product: 'message', lift: true },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['price-bands'] }),
  });

  return (
    <section className="flex max-w-[960px] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Коридор цены сообщения</h2>
        <span className="text-muted-foreground">границы — цена за одно сообщение</span>
      </div>

      {listError !== undefined && <ErrorNote error={listError} />}

      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
        {list.isPending ? (
          <span className="text-muted-foreground">Загружаем…</span>
        ) : band === undefined ? (
          <span className="text-muted-foreground">
            Коридора нет — партнёры назначают цену за сообщение без ограничений площадки (общие
            пределы продукта остаются).
          </span>
        ) : (
          <span>
            Цена за сообщение: <b className="num">{bandRange(band.min_price, band.max_price)}</b>
            <span className="num ml-2 text-muted-foreground">с {moment(band.effective_from)}</span>
          </span>
        )}
        {canChange && (
          <div className="ml-auto flex gap-2">
            <FormDialog
              label={band === undefined ? 'Задать коридор' : 'Изменить'}
              title="Коридор цены сообщения"
              description="Границы — цена за одно сообщение, которую партнёр может назначить в своём тарифе MAX."
              variant="outline"
              size="xs"
              open={open}
              onOpenChange={setOpen}
            >
              <NewMessageBand
                initial={band}
                onAdded={() => {
                  setOpen(false);
                }}
              />
            </FormDialog>
            {band !== undefined && (
              <ConfirmAction
                label="Снять"
                size="xs"
                tone="neutral"
                title="Снять коридор цены сообщения"
                consequence={
                  <p>
                    Партнёры смогут назначать цену за сообщение без ограничений площадки. Уже
                    назначенные цены не меняются.
                  </p>
                }
                confirmLabel="Снять коридор"
                onConfirm={() => lift.mutateAsync()}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Поля окна «Новый коридор цены сообщения»; подтверждение — поверх окна, как у звонков. */
function NewMessageBand({
  onAdded,
  initial,
}: {
  onAdded: () => void;
  initial?: MessageBand | undefined;
}) {
  const queryClient = useQueryClient();
  const [minPrice, setMinPrice] = useState(initial?.min_price ?? '');
  const [maxPrice, setMaxPrice] = useState(initial?.max_price ?? '');

  const add = useMutation({
    mutationFn: (input: { min: string | undefined; max: string | undefined }) =>
      request<unknown>('/price-bands', {
        method: 'POST',
        body: {
          product: 'message',
          ...(input.min === undefined ? {} : { minPrice: input.min }),
          ...(input.max === undefined ? {} : { maxPrice: input.max }),
        },
      }),
    onSuccess: () => {
      onAdded();
      void queryClient.invalidateQueries({ queryKey: ['price-bands'] });
    },
  });

  const min = moneyFromInput(minPrice);
  const max = moneyFromInput(maxPrice);
  const inverted = min !== undefined && max !== undefined && microunits(max) < microunits(min);
  const garbled =
    (minPrice.trim() !== '' && min === undefined) || (maxPrice.trim() !== '' && max === undefined);
  const ready = (min !== undefined || max !== undefined) && !garbled && !inverted;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
      }}
      className="flex min-h-0 flex-col"
    >
      <div className="grid min-h-0 gap-3 overflow-y-auto px-5 pb-4 sm:grid-cols-2">
        <DialogField label="Не ниже, ₽">
          <Input
            className="num"
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            placeholder="0,10"
            value={minPrice}
            onChange={(event) => {
              setMinPrice(event.target.value);
            }}
          />
        </DialogField>
        <DialogField label="Не выше, ₽">
          <Input
            className="num"
            inputMode="decimal"
            autoComplete="off"
            placeholder="2,00"
            value={maxPrice}
            onChange={(event) => {
              setMaxPrice(event.target.value);
            }}
          />
        </DialogField>
        {garbled && (
          <p className="text-warn sm:col-span-2">
            Границы — суммы в рублях, не больше шести знаков после запятой: например 0,10.
          </p>
        )}
        {inverted && (
          <p className="text-warn sm:col-span-2">
            Верхняя граница ниже нижней — поменяйте их местами.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
        <ConfirmAction
          label={initial === undefined ? 'Добавить' : 'Сохранить'}
          variant="default"
          tone="neutral"
          disabled={!ready}
          title="Коридор цены сообщения"
          consequence={
            <>
              <p>
                Партнёры смогут назначать цену за сообщение только в границах:{' '}
                <b className="num">{bandRange(min ?? null, max ?? null)}</b>. Коридор действует с
                этой минуты.
              </p>
              <p>
                Уже назначенные цены за его границами останутся и будут считаться по-прежнему; новую
                цену в тарифе придётся задать внутри границ.
              </p>
            </>
          }
          confirmLabel={initial === undefined ? 'Добавить коридор' : 'Сохранить коридор'}
          onConfirm={() => add.mutateAsync({ min, max })}
        />
        <DialogClose asChild>
          <Button type="button" variant="outline" size="sm">
            Отмена
          </Button>
        </DialogClose>
      </div>
    </form>
  );
}
