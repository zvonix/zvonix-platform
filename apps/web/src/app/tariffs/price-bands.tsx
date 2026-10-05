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
 * Добавление — окном, а в нём через подтверждение: проверка коридора идёт при назначении цены,
 * поэтому суженный коридор оставляет уже назначенные цены снаружи, и это стоит сказать
 * до нажатия, а не найти потом в нарушениях.
 */
export function PriceBands() {
  const canChange = useCanChange();
  const operators = useOperators();
  const [open, setOpen] = useState(false);

  const list = useQuery({
    queryKey: ['price-bands'],
    queryFn: () => request<{ bands: PriceBand[] }>('/price-bands'),
  });

  const listError = asApiError(list.error);

  return (
    <section className="flex max-w-[960px] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Коридоры цен</h2>
        <span className="text-muted-foreground">
          границы — стоимость вызова в 60 секунд, а не цена за минуту
        </span>
        {canChange && (
          <FormDialog
            label="Добавить коридор"
            title="Новый коридор цен"
            description="Границы — стоимость вызова в 60 секунд, а не цена за минуту."
            variant="outline"
            open={open}
            onOpenChange={setOpen}
          >
            <NewPriceBand
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

/**
 * Поля окна «Новый коридор цен». Кнопка окна не заводит коридор сама, а открывает
 * подтверждение поверх него; отказ API показывается там же. Окно закрывается
 * вызывающим, когда коридор заведён.
 */
function NewPriceBand({ onAdded }: { onAdded: () => void }) {
  const queryClient = useQueryClient();
  const operators = useOperators();
  const [operatorId, setOperatorId] = useState('');
  const [region, setRegion] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');

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
      onAdded();
      // По префиксу: заодно обновляются и нарушения коридора, ключ которых начинается так же.
      void queryClient.invalidateQueries({ queryKey: ['price-bands'] });
    },
  });

  const min = moneyFromInput(minPrice);
  const max = moneyFromInput(maxPrice);
  // Сравнение в микроединицах, а не числами с плавающей точкой: границы — деньги.
  const inverted = min !== undefined && max !== undefined && microunits(max) < microunits(min);
  const ready = operatorId !== '' && min !== undefined && max !== undefined && !inverted;
  const operatorName = operators.nameOf(operatorId) ?? 'оператор';
  const regionName = region.trim() === '' ? 'все регионы' : region.trim();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
      }}
      className="flex min-h-0 flex-col"
    >
      <div className="grid min-h-0 gap-3 overflow-y-auto px-5 pb-4 sm:grid-cols-2">
        <DialogField label="Оператор">
          <select
            value={operatorId}
            disabled={!operators.ready}
            autoFocus
            onChange={(event) => {
              setOperatorId(event.target.value);
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2"
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
        </DialogField>

        <DialogField label="Регион">
          <Input
            autoComplete="off"
            value={region}
            placeholder="все регионы"
            onChange={(event) => {
              setRegion(event.target.value);
            }}
          />
        </DialogField>

        <DialogField label="Не ниже, ₽">
          <Input
            className="num"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0,50"
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
            placeholder="3,00"
            value={maxPrice}
            onChange={(event) => {
              setMaxPrice(event.target.value);
            }}
          />
        </DialogField>

        {((minPrice !== '' && min === undefined) || (maxPrice !== '' && max === undefined)) && (
          <p className="text-warn sm:col-span-2">
            Границы — суммы в рублях, не больше шести знаков после запятой: например 0,50.
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
        <DialogClose asChild>
          <Button type="button" variant="outline" size="sm">
            Отмена
          </Button>
        </DialogClose>
      </div>
    </form>
  );
}
