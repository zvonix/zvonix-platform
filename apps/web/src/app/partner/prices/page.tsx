'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
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
import { ApiError, request } from '@/lib/api';
import { TERMINATION_KIND_MEANING, TERMINATION_KIND_NAME } from '@/lib/labels';
import { money } from '@/lib/money';
import {
  PARTNER_RATES_KEY,
  tariffOfRate,
  usePartnerRates,
  type PartnerRates,
  type Rate,
  type Tariff,
} from '@/lib/tariffs';
import { CallsAndMax, MaxPrices } from '../messages/terms';
import { SetPrice } from './set-price';

export default function PartnerPricesPage() {
  return (
    <ConsoleShell title="Мои тарифы" cabinet="partner">
      {() => <CallsAndMax calls={<PartnerTariffs />} max={<MaxPrices />} />}
    </ConsoleShell>
  );
}

/**
 * Тарифы партнёра ([ADR-0056](../../../../../../docs/adr/0056-tarify-partnyora.md)):
 * у каждого свои цены. Тариф выбирается у шлюза и меняется у карты — на странице
 * оборудования; что есть в тарифе карты, туда она и звонит.
 */
function PartnerTariffs() {
  const prices = usePartnerRates();

  if (prices.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {prices.error.message}
      </p>
    );
  }
  if (prices.isPending) return <p className="text-muted-foreground">Загружаем…</p>;

  const { rates, tariffs, operators_without_price: silent } = prices.data;
  const outside = rates.filter((rate) => !rate.within_band);

  return (
    <div className="flex flex-col gap-6">
      {/* Без вступительного текста: страница читается по таблицам (владелец, 2026-09-30). */}
      <div>
        <NewTariff />
      </div>

      {outside.length > 0 && (
        <p className="text-warn">
          {outside.length === 1
            ? 'Одна цена вышла'
            : `Цен вышло за коридор: ${String(outside.length)}`}{' '}
          за коридор площадки. Новые вызовы по ней считаются как есть, но площадка такую цену
          пересмотрит.
        </p>
      )}

      {tariffs.map((tariff) => (
        <TariffCard
          key={tariff.id}
          tariff={tariff}
          rates={rates.filter((rate) => tariffOfRate(rate, tariffs) === tariff.id)}
          data={prices.data}
        />
      ))}

      {silent.length > 0 && (
        <div className="flex max-w-prose flex-col gap-2">
          <h3 className="font-semibold">Нет цены — не звоните на</h3>
          <p>{silent.map((operator) => operator.operator_name).join(' · ')}</p>
        </div>
      )}
    </div>
  );
}

function TariffCard({
  tariff,
  rates,
  data,
}: {
  tariff: Tariff;
  rates: readonly Rate[];
  data: PartnerRates;
}) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: PARTNER_RATES_KEY });
  const seconds = data.reference_call_seconds;
  const columns = data.bands_enabled ? 6 : 5;
  // Общая цена — первой: исключения читаются относительно неё.
  const ordered = [...rates].sort(
    (left, right) => Number(left.operator_id !== null) - Number(right.operator_id !== null),
  );

  return (
    <section
      aria-label={`Тариф «${tariff.name}»`}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted/40 px-3 py-2">
        <h3 className="font-semibold [overflow-wrap:anywhere]">{tariff.name}</h3>
        {tariff.is_default && (
          <span className="rounded-full border border-border px-2 text-muted-foreground">
            по умолчанию
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <SetPrice tariff={tariff} operators={data.operators} bandsEnabled={data.bands_enabled} />
          <RenameTariff tariff={tariff} />
          {!tariff.is_default && <MakeDefault tariff={tariff} />}
          {!tariff.is_default && (
            <ConfirmAction
              label="Удалить"
              title={`Удалить тариф «${tariff.name}»`}
              consequence={
                <p>
                  Тариф удаляется вместе с его ценами. Если он выбран у шлюза или карты или по его
                  цене уже были звонки, площадка откажет — сначала выберите картам другой тариф.
                </p>
              }
              confirmLabel="Удалить тариф"
              onConfirm={async () => {
                await request<unknown>(`/partner/tariffs/${tariff.id}`, { method: 'DELETE' });
                await refresh();
              }}
            />
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Куда</TableHead>
              <TableHead className="h-8">Через что</TableHead>
              <TableHead className="h-8 text-right">За минуту</TableHead>
              <TableHead className="h-8">Как считается</TableHead>
              <TableHead className="h-8 text-right">Вызов {seconds} с</TableHead>
              {data.bands_enabled && <TableHead className="h-8">Коридор</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns} className="whitespace-normal text-muted-foreground">
                  Цен нет — карты с этим тарифом не звонят.
                </TableCell>
              </TableRow>
            )}
            {ordered.map((rate) => (
              <TableRow key={rate.id}>
                <TableCell>
                  {rate.operator_id === null ? (
                    <span className="font-semibold">Все операторы</span>
                  ) : (
                    (rate.operator_name ?? (
                      <span className="text-faint">оператор без названия</span>
                    ))
                  )}
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
                {data.bands_enabled && (
                  <TableCell className={rate.within_band ? 'num' : 'num text-warn'}>
                    {rate.band === null ? (
                      <span className="text-faint">не задан</span>
                    ) : (
                      `${money(rate.band.min_price)} — ${money(rate.band.max_price)}`
                    )}
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
 * Тариф по умолчанию — тот, по которому звонят карты без своего тарифа на шлюзах без
 * своего. Снять умолчание нельзя — только назначить другой тариф.
 */
function MakeDefault({ tariff }: { tariff: Tariff }) {
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: () =>
      request<unknown>(`/partner/tariffs/${tariff.id}`, {
        method: 'PATCH',
        body: { isDefault: true },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PARTNER_RATES_KEY }),
  });
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={change.isPending}
        onClick={() => {
          change.mutate();
        }}
      >
        Сделать по умолчанию
      </Button>
      {change.error instanceof ApiError && <ErrorNote error={change.error} />}
    </div>
  );
}

function NewTariff() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  return (
    <FormDialog label="Новый тариф" title="Новый тариф" variant="outline">
      <DialogForm
        submitLabel="Создать тариф"
        canSubmit={name.trim() !== ''}
        onSubmit={async () => {
          await request<unknown>('/partner/tariffs', {
            method: 'POST',
            body: { name: name.trim() },
          });
          setName('');
          await queryClient.invalidateQueries({ queryKey: PARTNER_RATES_KEY });
        }}
      >
        <DialogField label="Название" wide>
          <Input
            required
            autoFocus
            maxLength={60}
            autoComplete="off"
            placeholder="например, «Только МТС»"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </DialogField>
      </DialogForm>
    </FormDialog>
  );
}

function RenameTariff({ tariff }: { tariff: Tariff }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(tariff.name);
  return (
    <FormDialog
      label="Переименовать"
      title={`Переименовать тариф «${tariff.name}»`}
      variant="outline"
      size="sm"
    >
      <DialogForm
        submitLabel="Переименовать"
        canSubmit={name.trim() !== '' && name.trim() !== tariff.name}
        onSubmit={async () => {
          await request<unknown>(`/partner/tariffs/${tariff.id}`, {
            method: 'PATCH',
            body: { name: name.trim() },
          });
          await queryClient.invalidateQueries({ queryKey: PARTNER_RATES_KEY });
        }}
      >
        <DialogField label="Название" wide>
          <Input
            required
            autoFocus
            maxLength={60}
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </DialogField>
      </DialogForm>
    </FormDialog>
  );
}

/** Как считается разговор: шаг тарификации и первый оплачиваемый период. */
function billing(rate: Rate): string {
  const step =
    rate.billing_increment_seconds === 1
      ? 'посекундно'
      : rate.billing_increment_seconds === 60
        ? 'поминутно'
        : `шагом по ${String(rate.billing_increment_seconds)} с`;
  return rate.minimum_duration_seconds === 0
    ? step
    : `${step}, первые ${String(rate.minimum_duration_seconds)} с целиком`;
}
