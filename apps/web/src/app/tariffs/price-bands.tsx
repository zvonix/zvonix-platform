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
import { bandRange, microunits, money, moneyFromInput } from '@/lib/money';

interface PriceBand {
  readonly id: string;
  /** Пусто — коридор на любой оператор. */
  readonly operator_id: string | null;
  readonly region: string | null;
  /** Пусто — без нижней границы. */
  readonly min_price: string | null;
  /** Пусто — без верхней границы. */
  readonly max_price: string | null;
  readonly effective_from: string;
}

/**
 * Действующие коридоры: по одному на направление. Список приходит со свежими сверху, поэтому первый из
 * начавших действовать и есть действующий; снятый (обе границы пусты) направление открывает и в список не попадает.
 * Историю прежних границ хранит журнал, а не экран: одно направление — одна строка.
 */
function currentBands(bands: readonly PriceBand[]): PriceBand[] {
  const now = Date.now();
  const seen = new Set<string>();
  const result: PriceBand[] = [];
  for (const band of bands) {
    if (new Date(band.effective_from).getTime() > now) continue;
    const key = `${band.operator_id ?? '*'}|${band.region?.toLowerCase() ?? '*'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (band.min_price !== null || band.max_price !== null) result.push(band);
  }
  return result;
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
 * Оператор можно не называть («любой оператор»: коридор на всех, у оператора со своим коридором
 * действует свой), и границу можно задать одну — только «не ниже» или только «не выше» (владелец, 2026-10-16).
 * Направление без коридора партнёру открыто: коридор — рамка там, где площадка её задала (ADR-0056).
 *
 * Одно направление — один коридор: «Изменить» заменяет границы, «Снять» открывает направление партнёрам
 * (владелец, 2026-10-16; прежние границы остаются в журнале).
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
  const bands = currentBands(list.data?.bands ?? []);

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
              {canChange && <TableHead className="h-8" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={canChange ? 6 : 5} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {list.data !== undefined && bands.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={canChange ? 6 : 5}
                  className="whitespace-normal text-muted-foreground"
                >
                  Коридоров нет — партнёры назначают цены без ограничений. Коридор ставит рамку там,
                  где вы хотите её задать.
                </TableCell>
              </TableRow>
            )}

            {bands.map((band) => (
              <TableRow key={band.id}>
                <TableCell>
                  {band.operator_id === null ? (
                    <span className="font-medium">любой оператор</span>
                  ) : (
                    (operators.nameOf(band.operator_id) ?? (
                      <span className="num text-faint">{band.operator_id}</span>
                    ))
                  )}
                </TableCell>
                <TableCell>
                  {band.region ?? <span className="text-muted-foreground">все</span>}
                </TableCell>
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
                </TableCell>
                {canChange && (
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <BandEdit band={band} />
                      <LiftBand band={band} />
                    </div>
                  </TableCell>
                )}
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
function NewPriceBand({ onAdded, initial }: { onAdded: () => void; initial?: PriceBand }) {
  const queryClient = useQueryClient();
  const operators = useOperators();
  const [operatorId, setOperatorId] = useState(initial?.operator_id ?? '');
  const [region, setRegion] = useState(initial?.region ?? '');
  const [minPrice, setMinPrice] = useState(initial?.min_price ?? '');
  const [maxPrice, setMaxPrice] = useState(initial?.max_price ?? '');
  // При изменении направление то же: оператор и регион не правятся.
  const changing = initial !== undefined;

  const add = useMutation({
    mutationFn: (input: { min: string | undefined; max: string | undefined }) =>
      request<unknown>('/price-bands', {
        method: 'POST',
        body: {
          ...(operatorId === '' ? {} : { operatorId }),
          ...(region.trim() === '' ? {} : { region: region.trim() }),
          ...(input.min === undefined ? {} : { minPrice: input.min }),
          ...(input.max === undefined ? {} : { maxPrice: input.max }),
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
  // Границ можно задать одну, но не ноль; набранное, но не разобранное как сумма, коридор не готовит.
  const garbled =
    (minPrice.trim() !== '' && min === undefined) || (maxPrice.trim() !== '' && max === undefined);
  const ready = (min !== undefined || max !== undefined) && !garbled && !inverted;
  const operatorName =
    operatorId === '' ? 'любой оператор' : (operators.nameOf(operatorId) ?? 'оператор');
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
            disabled={!operators.ready || changing}
            autoFocus
            onChange={(event) => {
              setOperatorId(event.target.value);
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2"
          >
            <option value="">{operators.ready ? 'любой оператор' : 'загружаем операторов…'}</option>
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
            disabled={changing}
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

        {garbled && (
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
          label={changing ? 'Сохранить' : 'Добавить'}
          variant="default"
          tone="neutral"
          disabled={!ready}
          title={`Коридор цен: ${operatorName}, ${regionName}`}
          consequence={
            <>
              <p>
                Партнёры смогут назначать цену по этому направлению только в границах:{' '}
                <b className="num">{bandRange(min ?? null, max ?? null)}</b> за вызов в 60 секунд.
                {operatorId === ''
                  ? ' Коридор касается всех операторов, у которых нет своего.'
                  : ''}{' '}
                Коридор действует с этой минуты.{' '}
                {changing ? 'Он заменит действующий коридор этого направления.' : ''}
              </p>
              <p>
                Уже назначенные цены за его границами останутся и будут считаться по-прежнему, но
                попадут в «Нарушения коридора» — их придётся пересмотреть.
              </p>
            </>
          }
          confirmLabel={changing ? 'Сохранить коридор' : 'Добавить коридор'}
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

/** «Изменить» в строке коридора: то же окно, направление зафиксировано. */
function BandEdit({ band }: { band: PriceBand }) {
  const [open, setOpen] = useState(false);
  return (
    <FormDialog
      label="Изменить"
      title="Изменить коридор цен"
      description="Границы — стоимость вызова в 60 секунд. Направление остаётся прежним."
      variant="outline"
      size="xs"
      open={open}
      onOpenChange={setOpen}
    >
      <NewPriceBand
        initial={band}
        onAdded={() => {
          setOpen(false);
        }}
      />
    </FormDialog>
  );
}

/** «Снять» коридор направления: партнёрам направление снова открыто; прежние границы остаются в журнале. */
function LiftBand({ band }: { band: PriceBand }) {
  const queryClient = useQueryClient();
  const operators = useOperators();
  const lift = useMutation({
    mutationFn: () =>
      request<unknown>('/price-bands', {
        method: 'POST',
        body: {
          lift: true,
          ...(band.operator_id === null ? {} : { operatorId: band.operator_id }),
          ...(band.region === null ? {} : { region: band.region }),
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['price-bands'] }),
  });
  const operatorName =
    band.operator_id === null
      ? 'любой оператор'
      : (operators.nameOf(band.operator_id) ?? 'оператор');
  return (
    <ConfirmAction
      label="Снять"
      size="xs"
      tone="neutral"
      title={`Снять коридор: ${operatorName}, ${band.region ?? 'все регионы'}`}
      consequence={
        <p>
          Партнёры смогут назначать цену по этому направлению без ограничений площадки. Уже
          назначенные цены не меняются.
        </p>
      }
      confirmLabel="Снять коридор"
      onConfirm={() => lift.mutateAsync()}
    />
  );
}
