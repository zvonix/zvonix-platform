'use client';

import { useQuery } from '@tanstack/react-query';
import type { TerminationKind } from '@zvonix/shared';
import { ConsoleShell } from '@/components/console-shell';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';
import { TERMINATION_KIND_MEANING, TERMINATION_KIND_NAME } from '@/lib/labels';
import { money } from '@/lib/money';
import { SetPrice } from './set-price';

interface Rate {
  readonly id: string;
  readonly operator_id: string;
  readonly operator_name: string | null;
  readonly region: string | null;
  readonly termination_kind: TerminationKind;
  readonly price_per_minute: string;
  readonly billing_increment_seconds: number;
  readonly minimum_duration_seconds: number;
  readonly connection_fee: string;
  readonly effective_from: string;
  readonly reference_cost: string;
  readonly band: { readonly min_price: string; readonly max_price: string } | null;
  readonly within_band: boolean;
}

interface Rates {
  readonly reference_call_seconds: number;
  readonly rates: readonly Rate[];
  readonly operators_without_price: readonly {
    readonly operator_id: string;
    readonly operator_name: string;
  }[];
  /** Направления, открытые площадкой, с рамками. Чего здесь нет — оценить нельзя. */
  readonly open_directions: readonly {
    readonly operator_id: string;
    readonly operator_name: string;
    readonly min_price: string;
    readonly max_price: string;
  }[];
}

const COLUMNS = 6;

export default function PartnerPricesPage() {
  return (
    <ConsoleShell title="Мои цены" cabinet="partner">
      {() => <PartnerPrices />}
    </ConsoleShell>
  );
}

function PartnerPrices() {
  const prices = useQuery({
    queryKey: ['partner', 'rates'],
    queryFn: () => request<Rates>('/partner/rates'),
  });

  if (prices.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {prices.error.message}
      </p>
    );
  }

  if (prices.isPending) return <p className="text-muted-foreground">Загружаем…</p>;

  const { rates, reference_call_seconds: seconds, operators_without_price: silent } = prices.data;
  const outside = rates.filter((rate) => !rate.within_band);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="max-w-prose text-muted-foreground">
          Это то, что площадка платит вам за минуту разговора. Клиент видит другое число — своё, с
          наценкой площадки внутри, — и по нему расставляет порядок партнёров. Дешевле у вас, значит
          раньше в очереди.
        </p>
        <SetPrice directions={prices.data.open_directions} />
      </div>

      {outside.length > 0 && (
        <p className="text-warn">
          {outside.length === 1
            ? 'Одна цена вышла'
            : `Цен вышло за коридор: ${String(outside.length)}`}{' '}
          за коридор направления. Новые вызовы по ней считаются как есть, но площадка такую цену
          пересмотрит — коридор задаётся ею.
        </p>
      )}

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Направление</TableHead>
              <TableHead className="h-8">Через что</TableHead>
              <TableHead className="h-8 text-right">За минуту</TableHead>
              <TableHead className="h-8">Как считается</TableHead>
              <TableHead className="h-8 text-right">Вызов {seconds} с</TableHead>
              <TableHead className="h-8">Коридор</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rates.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="whitespace-normal text-muted-foreground">
                  Цен нет ни по одному направлению. Пока их нет, вызовы через вас не идут вовсе:
                  тарифицировать их нечем. Назначьте цену по направлению, где площадка открыла
                  коридор.
                </TableCell>
              </TableRow>
            )}

            {rates.map((rate) => (
              <TableRow key={rate.id}>
                <TableCell>
                  {rate.operator_name ?? <span className="text-faint">оператор без названия</span>}
                  <span className="block text-faint">{rate.region ?? 'любой регион'}</span>
                </TableCell>

                <TableCell title={TERMINATION_KIND_MEANING[rate.termination_kind]}>
                  {TERMINATION_KIND_NAME[rate.termination_kind]}
                </TableCell>

                <TableCell className="num text-right">{money(rate.price_per_minute)}</TableCell>

                <TableCell className="whitespace-normal">
                  {billing(rate)}
                  {rate.connection_fee !== '0' && (
                    <span className="block text-muted-foreground">
                      плюс {money(rate.connection_fee)} за соединение
                    </span>
                  )}
                </TableCell>

                {/*
                  Стоимость эталонного вызова, а не цена за минуту: тариф — это пять чисел,
                  и сравнивать их одним из них нельзя. С коридором сравнивается именно она.
                */}
                <TableCell className="num text-right font-semibold">
                  {money(rate.reference_cost)}
                </TableCell>

                <TableCell className={rate.within_band ? 'num' : 'num text-warn'}>
                  {rate.band === null ? (
                    <span className="text-faint">не задан</span>
                  ) : (
                    `${money(rate.band.min_price)} — ${money(rate.band.max_price)}`
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {silent.length > 0 && (
        <div className="flex max-w-prose flex-col gap-2">
          <h3 className="font-semibold">Операторы без вашей цены</h3>
          <p className="text-muted-foreground">
            По этим операторам у вас нет ни одной цены, а без неё вызов через вас не пойдёт вовсе —
            его нечем тарифицировать. Если у вас есть под них ёмкость, скажите площадке.
          </p>
          <p>{silent.map((operator) => operator.operator_name).join(' · ')}</p>
        </div>
      )}
    </div>
  );
}

/** Как считается разговор: шаг тарификации и первый оплачиваемый период. */
function billing(rate: Rate): string {
  const step =
    rate.billing_increment_seconds === 1
      ? 'посекундно'
      : `шагом по ${String(rate.billing_increment_seconds)} с`;
  return rate.minimum_duration_seconds === 0
    ? step
    : `${step}, первые ${String(rate.minimum_duration_seconds)} с целиком`;
}
