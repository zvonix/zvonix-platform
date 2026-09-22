'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ROUNDING_MODES,
  TERMINATION_KINDS,
  type Rounding,
  type TerminationKind,
} from '@zvonix/shared';
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
import { ROUNDING_NAME } from '@/lib/labels';
import { money, numberFromInput } from '@/lib/money';
import { TERMINATION_KIND_NAME } from '@/lib/labels';

interface Rate {
  readonly id: string;
  readonly operator_id: string;
  readonly termination_kind: TerminationKind;
  readonly region: string | null;
  readonly price_per_minute: string;
  readonly billing_increment_seconds: number;
  readonly minimum_duration_seconds: number;
  readonly connection_fee: string;
  readonly rounding: Rounding;
  readonly effective_from: string;
}

/**
 * Цены партнёра по направлениям.
 *
 * Направление — это **оператор и регион**, а не префикс номера: из-за переносимости
 * номер ничего не говорит об операторе
 * ([ADR-0013](../../../../../docs/adr/0013-opredelenie-operatora.md)). Регион пустой
 * означает «любой», и такая цена работает там, где региональной нет.
 *
 * Записи не редактируются, а добавляются: вызов, тарифицированный вчера, не должен
 * переоцениваться сегодняшней ценой. Поэтому в списке видна вся история, свежее сверху.
 */
export function PartnerRates({ partnerId }: { partnerId: string }) {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const operators = useOperators();
  const [open, setOpen] = useState(false);
  const [operatorId, setOperatorId] = useState('');
  const [terminationKind, setTerminationKind] = useState<TerminationKind>('sim');
  const [region, setRegion] = useState('');
  const [pricePerMinute, setPricePerMinute] = useState('');
  const [connectionFee, setConnectionFee] = useState('0');
  const [increment, setIncrement] = useState('1');
  const [minimum, setMinimum] = useState('0');
  const [rounding, setRounding] = useState<Rounding>('half_away_from_zero');

  const list = useQuery({
    queryKey: ['partner-rates', partnerId],
    queryFn: () => request<{ rates: Rate[] }>(`/partner-rates?partnerId=${partnerId}`),
  });

  const add = useMutation({
    mutationFn: () =>
      request<unknown>('/partner-rates', {
        method: 'POST',
        body: {
          partnerId,
          operatorId,
          terminationKind,
          ...(region.trim() === '' ? {} : { region: region.trim() }),
          pricePerMinute: numberFromInput(pricePerMinute),
          connectionFee: numberFromInput(connectionFee),
          billingIncrementSeconds: increment,
          minimumDurationSeconds: minimum,
          rounding,
        },
      }),
    onSuccess: async () => {
      setOpen(false);
      setRegion('');
      setPricePerMinute('');
      await queryClient.invalidateQueries({ queryKey: ['partner-rates', partnerId] });
      // Сужение коридора после назначения цены видно только этим списком,
      // и новая цена могла как создать нарушение, так и снять его.
      await queryClient.invalidateQueries({ queryKey: ['price-bands', 'violations'] });
    },
  });

  const error = add.error instanceof ApiError ? add.error : undefined;
  const ready = operatorId !== '' && pricePerMinute.trim() !== '';
  const rates = list.data?.rates ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h3 className="font-semibold">Цены по направлениям</h3>
        {canChange && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? 'Отменить' : 'Назначить цену'}
          </Button>
        )}
      </div>

      {list.data !== undefined && rates.length === 0 && (
        <p className="text-warn">
          Цен нет: вызовы через этого партнёра отклоняются с причиной «нет тарифа».
        </p>
      )}

      {canChange && open && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) add.mutate();
          }}
          className="flex max-w-[900px] flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Оператор</span>
            <select
              value={operatorId}
              onChange={(event) => {
                setOperatorId(event.target.value);
              }}
              className="h-9 w-[240px] rounded-md border border-input bg-transparent px-2"
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
              className="w-[180px]"
              value={region}
              placeholder="все регионы"
              onChange={(event) => {
                setRegion(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Через что</span>
            {/*
              Способ терминации — измерение цены, а не свойство железа (ADR-0040):
              внутри своей сети SIM почти бесплатна, транзит платный всегда. Одна цена
              на оба означала бы, что партнёр не может назвать настоящую ни для одного.
            */}
            <select
              value={terminationKind}
              onChange={(event) => {
                setTerminationKind(event.target.value as TerminationKind);
              }}
              className="h-9 w-[150px] rounded-md border border-input bg-transparent px-2"
            >
              {TERMINATION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {TERMINATION_KIND_NAME[kind]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">За минуту, ₽</span>
            <Input
              className="num w-[110px]"
              value={pricePerMinute}
              onChange={(event) => {
                setPricePerMinute(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">За соединение, ₽</span>
            <Input
              className="num w-[110px]"
              value={connectionFee}
              onChange={(event) => {
                setConnectionFee(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground" title="1 — посекундно, 60 — поминутно">
              Шаг, с
            </span>
            <Input
              className="num w-[80px]"
              value={increment}
              onChange={(event) => {
                setIncrement(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Минимум, с</span>
            <Input
              className="num w-[80px]"
              value={minimum}
              onChange={(event) => {
                setMinimum(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Округление</span>
            <select
              value={rounding}
              onChange={(event) => {
                setRounding(event.target.value as Rounding);
              }}
              className="h-9 rounded-md border border-input bg-transparent px-2"
            >
              {ROUNDING_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {ROUNDING_NAME[mode]}
                </option>
              ))}
            </select>
          </label>

          <Button type="submit" size="sm" disabled={!ready || add.isPending}>
            Назначить
          </Button>

          <p className="w-full text-muted-foreground">
            Цена проверяется по действующему коридору и начинает действовать сейчас. Прежние записи
            остаются: по ним тарифицированы прошлые вызовы.
          </p>
        </form>
      )}

      {error !== undefined && <ErrorNote error={error} />}

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className="max-w-[900px] rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Оператор</TableHead>
              <TableHead className="h-8">Через что</TableHead>
              <TableHead className="h-8">Регион</TableHead>
              <TableHead className="h-8 text-right">За минуту</TableHead>
              <TableHead className="h-8 text-right">За соединение</TableHead>
              <TableHead className="h-8 text-right">Шаг</TableHead>
              <TableHead className="h-8 text-right">Минимум</TableHead>
              <TableHead className="h-8">Округление</TableHead>
              <TableHead className="h-8">Действует с</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={9} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {rates.map((rate) => (
              <TableRow key={rate.id}>
                <TableCell>
                  {operators.nameOf(rate.operator_id) ?? (
                    <span className="num text-faint">{rate.operator_id}</span>
                  )}
                </TableCell>
                <TableCell>{TERMINATION_KIND_NAME[rate.termination_kind]}</TableCell>
                <TableCell>
                  {rate.region ?? <span className="text-muted-foreground">все</span>}
                </TableCell>
                <TableCell className="num text-right">{money(rate.price_per_minute)}</TableCell>
                <TableCell className="num text-right text-muted-foreground">
                  {money(rate.connection_fee)}
                </TableCell>
                <TableCell className="num text-right text-muted-foreground">
                  {rate.billing_increment_seconds} с
                </TableCell>
                <TableCell className="num text-right text-muted-foreground">
                  {rate.minimum_duration_seconds} с
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {ROUNDING_NAME[rate.rounding]}
                </TableCell>
                <TableCell>
                  <span className="num text-muted-foreground">{moment(rate.effective_from)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
