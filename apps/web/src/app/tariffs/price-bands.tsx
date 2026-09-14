'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
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
import { ApiError, request } from '@/lib/api';
import { useOperators } from '@/lib/dictionaries';
import { moment } from '@/lib/format';
import { microunits, money, moneyFromInput } from '@/lib/money';

interface PriceBand {
  readonly id: string;
  readonly operator_id: string;
  readonly region: string | null;
  readonly min_price: string;
  readonly max_price: string;
  readonly effective_from: string;
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/**
 * Коридоры цен ([ADR-0023](../../../../../docs/adr/0023-koridory-cen.md)).
 *
 * Границы задаются **стоимостью эталонного вызова в 60 секунд**, а не ценой за минуту:
 * коридор по одной цене за минуту обходится платой за соединение или минимальной
 * длительностью в десять минут — то есть не ограничивает ничего.
 *
 * С тех пор как цену назначает сам партнёр, **направление без коридора ему закрыто**:
 * его цену API отвергает (`TariffService`). Администратору — нет: он коридор и задаёт.
 * Прежний текст экрана «коридоров нет — цена ничем не ограничена» говорил обратное
 * (ui-review, 2026-09-14).
 *
 * Добавление — через подтверждение: проверка коридора идёт при назначении цены,
 * поэтому суженный коридор оставляет уже назначенные цены снаружи, и это стоит сказать
 * до нажатия, а не найти потом в нарушениях.
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
    mutationFn: (input: { min: string; max: string }) =>
      request<unknown>('/price-bands', {
        method: 'POST',
        body: {
          operatorId,
          ...(region.trim() === '' ? {} : { region: region.trim() }),
          minPrice: input.min,
          maxPrice: input.max,
        },
      }),
    onSuccess: () => {
      setOpen(false);
      setRegion('');
      setMinPrice('');
      setMaxPrice('');
      // По префиксу: заодно обновляются и нарушения коридора, ключ которых начинается так же.
      void queryClient.invalidateQueries({ queryKey: ['price-bands'] });
    },
  });

  const listError = asApiError(list.error);
  const min = moneyFromInput(minPrice);
  const max = moneyFromInput(maxPrice);
  // Сравнение в микроединицах, а не числами с плавающей точкой: границы — деньги.
  const inverted = min !== undefined && max !== undefined && microunits(max) < microunits(min);
  const ready = operatorId !== '' && min !== undefined && max !== undefined && !inverted;
  const operatorName = operators.nameOf(operatorId) ?? 'оператор';
  const regionName = region.trim() === '' ? 'все регионы' : region.trim();

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
          }}
          className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Оператор</span>
            <select
              value={operatorId}
              disabled={!operators.ready}
              onChange={(event) => {
                setOperatorId(event.target.value);
              }}
              className="h-9 w-[280px] rounded-md border border-input bg-transparent px-2"
            >
              <option value="">
                {operators.ready ? 'выберите оператора' : 'загружаем операторов…'}
              </option>
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
              autoComplete="off"
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
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,50"
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
              inputMode="decimal"
              autoComplete="off"
              placeholder="3,00"
              value={maxPrice}
              onChange={(event) => {
                setMaxPrice(event.target.value);
              }}
            />
          </label>

          <ConfirmAction
            label="Добавить"
            variant="default"
            tone="neutral"
            disabled={!ready}
            title={`Коридор цен: ${operatorName}, ${regionName}`}
            consequence={
              <>
                <p>
                  Партнёры смогут назначать цену по этому направлению только в границах от{' '}
                  <b className="num">{min === undefined ? '' : money(min)}</b> до{' '}
                  <b className="num">{max === undefined ? '' : money(max)}</b> за вызов в 60 секунд.
                  Коридор действует с этой минуты.
                </p>
                <p>
                  Уже назначенные цены за его границами останутся и будут считаться по-прежнему, но
                  попадут в «Нарушения коридора» — их придётся пересмотреть.
                </p>
              </>
            }
            confirmLabel="Добавить коридор"
            onConfirm={() => add.mutateAsync({ min: min ?? '0', max: max ?? '0' })}
          />

          {((minPrice !== '' && min === undefined) || (maxPrice !== '' && max === undefined)) && (
            <p className="w-full text-warn">
              Границы — суммы в рублях, не больше шести знаков после запятой: например 0,50.
            </p>
          )}
          {inverted && (
            <p className="w-full text-warn">Верхняя граница ниже нижней — поменяйте их местами.</p>
          )}
        </form>
      )}

      {listError !== undefined && <ErrorNote error={listError} />}

      <div className="max-w-[760px] overflow-x-auto rounded-md border border-border bg-card">
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
                <TableCell colSpan={5} className="whitespace-normal text-muted-foreground">
                  Коридоров нет — значит, ни по одному направлению партнёр не может назначить цену
                  сам: без коридора его цена отклоняется. Администратор назначает цену и без
                  коридора.
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
