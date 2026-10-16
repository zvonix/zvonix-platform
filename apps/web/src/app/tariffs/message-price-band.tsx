'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { DialogField, FormDialog } from '@/components/form-dialog';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { bandRange, microunits, money, moneyFromInput } from '@/lib/money';

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
 * (направлений нет — ни оператора, ни региона) и границы — цена **за одно сообщение**. Действует последний из
 * начавших действовать; одну из границ можно не задавать.
 */
export function MessagePriceBand() {
  const canChange = useCanChange();
  const [open, setOpen] = useState(false);

  const list = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => request<{ bands: MessageBand[] }>('/price-bands?product=message'),
  });
  const listError = asApiError(list.error);

  return (
    <section className="flex max-w-[960px] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Коридор цены сообщения</h2>
        <span className="text-muted-foreground">границы — цена за одно сообщение</span>
        {canChange && (
          <FormDialog
            label="Добавить коридор"
            title="Новый коридор цены сообщения"
            description="Границы — цена за одно сообщение, которую партнёр может назначить в своём тарифе MAX."
            variant="outline"
            open={open}
            onOpenChange={setOpen}
          >
            <NewMessageBand
              onAdded={() => {
                setOpen(false);
              }}
            />
          </FormDialog>
        )}
      </div>

      {listError !== undefined && <ErrorNote error={listError} />}

      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8 text-right">Не ниже</TableHead>
              <TableHead className="h-8 text-right">Не выше</TableHead>
              <TableHead className="h-8">Действует с</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {list.data?.bands.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="whitespace-normal text-muted-foreground">
                  Коридора нет — партнёры назначают цену за сообщение без ограничений площадки
                  (общие пределы продукта остаются).
                </TableCell>
              </TableRow>
            )}

            {list.data?.bands.map((band, index) => (
              <TableRow key={band.id}>
                <TableCell className="num text-right">
                  {band.min_price === null ? (
                    <span className="text-muted-foreground">без границы</span>
                  ) : (
                    money(band.min_price)
                  )}
                </TableCell>
                <TableCell className="num text-right">
                  {band.max_price === null ? (
                    <span className="text-muted-foreground">без границы</span>
                  ) : (
                    money(band.max_price)
                  )}
                </TableCell>
                <TableCell>
                  <span className="num text-muted-foreground">{moment(band.effective_from)}</span>
                  {index === 0 && <span className="ml-2 text-ok">действует</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** Поля окна «Новый коридор цены сообщения»; подтверждение — поверх окна, как у звонков. */
function NewMessageBand({ onAdded }: { onAdded: () => void }) {
  const queryClient = useQueryClient();
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');

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
        <DialogField label="Не ниже, ₽ (можно пусто)">
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
        <DialogField label="Не выше, ₽ (можно пусто)">
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
          label="Добавить"
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
          confirmLabel="Добавить коридор"
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
