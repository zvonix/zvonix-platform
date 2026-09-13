'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
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
import { ErrorNote } from '@/components/error-note';
import { ApiError, request } from '@/lib/api';
import { useOperators } from '@/lib/dictionaries';
import { moment } from '@/lib/format';
import { money, numberFromInput } from '@/lib/money';

interface PriceBand {
  readonly id: string;
  readonly operator_id: string;
  readonly region: string | null;
  readonly min_price: string;
  readonly max_price: string;
  readonly effective_from: string;
}

/**
 * Коридоры цен ([ADR-0023](../../../../../docs/adr/0023-koridory-cen.md)).
 *
 * Границы задаются **стоимостью эталонного вызова в 60 секунд**, а не ценой за минуту:
 * коридор по одной цене за минуту обходится платой за соединение или минимальной
 * длительностью в десять минут — то есть не ограничивает ничего.
 *
 * Коридора нет — ограничения нет. Пока цену назначает администратор, это верно;
 * когда её будет назначать партнёр, правило станет добровольным для той самой стороны,
 * ради ограничения которой оно заведено (записано в TASKS.md).
 */
export function PriceBands() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const operators = useOperators();
  const [open, setOpen] = useState(false);
  const [operatorId, setOperatorId] = useState('');
  const [region, setRegion] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');

  const list = useQuery({
    queryKey: ['price-bands'],
    queryFn: () => request<{ bands: PriceBand[] }>('/price-bands'),
  });

  const add = useMutation({
    mutationFn: () =>
      request<unknown>('/price-bands', {
        method: 'POST',
        body: {
          operatorId,
          ...(region.trim() === '' ? {} : { region: region.trim() }),
          minPrice: numberFromInput(minPrice),
          maxPrice: numberFromInput(maxPrice),
        },
      }),
    onSuccess: async () => {
      setOpen(false);
      setRegion('');
      setMinPrice('');
      setMaxPrice('');
      await queryClient.invalidateQueries({ queryKey: ['price-bands'] });
    },
  });

  const error = add.error instanceof ApiError ? add.error : undefined;
  const ready = operatorId !== '' && minPrice.trim() !== '' && maxPrice.trim() !== '';

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h2 className="font-semibold">Коридоры цен</h2>
        <span className="text-muted-foreground">
          границы — стоимость вызова в 60 секунд, а не цена за минуту
        </span>
        {canChange && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? 'Отменить' : 'Добавить коридор'}
          </Button>
        )}
      </div>

      {canChange && open && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) add.mutate();
          }}
          className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Оператор</span>
            <select
              value={operatorId}
              onChange={(event) => {
                setOperatorId(event.target.value);
              }}
              className="h-9 w-[280px] rounded-md border border-input bg-transparent px-2"
            >
              <option value="">выберите оператора</option>
              {operators.rows.map((operator) => (
                <option key={operator.id} value={operator.id}>
                  {operator.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Регион</span>
            <Input
              className="w-[200px]"
              value={region}
              placeholder="все регионы"
              onChange={(event) => {
                setRegion(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Не ниже, ₽</span>
            <Input
              className="num w-[110px]"
              value={minPrice}
              onChange={(event) => {
                setMinPrice(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Не выше, ₽</span>
            <Input
              className="num w-[110px]"
              value={maxPrice}
              onChange={(event) => {
                setMaxPrice(event.target.value);
              }}
            />
          </label>

          <Button type="submit" size="sm" disabled={!ready || add.isPending}>
            Добавить
          </Button>
        </form>
      )}

      {error !== undefined && <ErrorNote error={error} />}

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className="max-w-[760px] rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Оператор</TableHead>
              <TableHead className="h-8">Регион</TableHead>
              <TableHead className="h-8 text-right">Не ниже</TableHead>
              <TableHead className="h-8 text-right">Не выше</TableHead>
              <TableHead className="h-8">Действует с</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {list.data?.bands.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="text-muted-foreground">
                  Коридоров нет — цена партнёра ничем не ограничена.
                </TableCell>
              </TableRow>
            )}

            {list.data?.bands.map((band) => (
              <TableRow key={band.id}>
                <TableCell>
                  {operators.nameOf(band.operator_id) ?? (
                    <span className="num text-faint">{band.operator_id}</span>
                  )}
                </TableCell>
                <TableCell>
                  {band.region ?? <span className="text-muted-foreground">все</span>}
                </TableCell>
                <TableCell className="num text-right">{money(band.min_price)}</TableCell>
                <TableCell className="num text-right">{money(band.max_price)}</TableCell>
                <TableCell>
                  <span className="num text-muted-foreground">{moment(band.effective_from)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
