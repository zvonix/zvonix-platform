'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TERMINATION_KINDS, type TerminationKind } from '@zvonix/shared';
import { useState } from 'react';
import { DialogField, FormDialog } from '@/components/form-dialog';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import { TERMINATION_KIND_NAME } from '@/lib/labels';
import { money, numberFromInput } from '@/lib/money';
import { PARTNER_RATES_KEY, type OperatorChoice, type Tariff } from '@/lib/tariffs';

/** Значение пункта «Все операторы» в списке: цена без оператора (ADR-0056). */
const ALL_OPERATORS = '*';

interface Draft {
  operatorId: string;
  terminationKind: TerminationKind;
  region: string;
  pricePerMinute: string;
  connectionFee: string;
  billingIncrementSeconds: string;
  minimumDurationSeconds: string;
}

const EMPTY: Draft = {
  operatorId: ALL_OPERATORS,
  terminationKind: 'sim',
  region: '',
  pricePerMinute: '',
  connectionFee: '',
  billingIncrementSeconds: '1',
  minimumDurationSeconds: '0',
};

/**
 * Назначение цены в тарифе ([ADR-0056](../../../../../../docs/adr/0056-tarify-partnyora.md)).
 *
 * Коридор стоит **рядом с полем**, а не в отказе после отправки: без рамок человек
 * вводит число вслепую ([ADR-0023](../../../../../../docs/adr/0023-koridory-cen.md)).
 * Направление без коридора открыто — коридор площадка ставит там, где хочет.
 *
 * Стоимость эталонного вызова не считается в браузере: кабинет деньги показывает,
 * а не вычисляет ([money.ts](../../../lib/money.ts)). Когда тариф не помещается
 * в коридор, точные числа приходят в отказе — считает их та же функция, которой
 * тарифицируется настоящий вызов.
 */
export function SetPrice({
  tariff,
  operators,
  bandsEnabled,
}: {
  tariff: Tariff;
  operators: readonly OperatorChoice[];
  bandsEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <FormDialog
      label="Назначить цену"
      title={`Цена в тарифе «${tariff.name}»`}
      size="sm"
      open={open}
      onOpenChange={(next) => {
        // Пока цена отправляется, окно не закрывается: иначе ответ пришёл бы в пустоту.
        if (!pending) setOpen(next);
      }}
    >
      <PriceForm
        tariff={tariff}
        operators={operators}
        bandsEnabled={bandsEnabled}
        onPending={setPending}
        onSaved={() => {
          setOpen(false);
        }}
      />
    </FormDialog>
  );
}

/**
 * Поля окна «Назначить цену».
 *
 * Не `DialogForm`: отказ по коридору показывается с числами ({@link Refusal}), а общая
 * строка отказа окна их не знает.
 */
function PriceForm({
  tariff,
  operators,
  bandsEnabled,
  onPending,
  onSaved,
}: {
  tariff: Tariff;
  operators: readonly OperatorChoice[];
  bandsEnabled: boolean;
  onPending: (pending: boolean) => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const everyone = draft.operatorId === ALL_OPERATORS;
  const chosen = operators.find((operator) => operator.operator_id === draft.operatorId);

  const save = useMutation({
    mutationFn: () =>
      request<{ rate: { id: string } }>('/partner/rates', {
        method: 'POST',
        body: {
          tariffId: tariff.id,
          operatorId: everyone ? null : draft.operatorId,
          terminationKind: draft.terminationKind,
          // Пустой регион означает «любой», и отправлять пустую строку нельзя:
          // схема требует осмысленное название, а не пробел.
          ...(draft.region.trim() === '' ? {} : { region: draft.region.trim() }),
          pricePerMinute: numberFromInput(draft.pricePerMinute),
          ...(draft.connectionFee.trim() === ''
            ? {}
            : { connectionFee: numberFromInput(draft.connectionFee) }),
          billingIncrementSeconds: draft.billingIncrementSeconds,
          minimumDurationSeconds: draft.minimumDurationSeconds,
        },
      }),
    onMutate: () => {
      onPending(true);
    },
    onSettled: () => {
      onPending(false);
    },
    onSuccess: () => {
      onSaved();
      void queryClient.invalidateQueries({ queryKey: PARTNER_RATES_KEY });
    },
  });

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending) save.mutate();
      }}
    >
      <div className="grid min-h-0 gap-3 overflow-y-auto px-5 pb-4 sm:grid-cols-2">
        <DialogField label="Куда">
          <select
            required
            autoFocus
            value={draft.operatorId}
            onChange={(event) => {
              setDraft({ ...draft, operatorId: event.target.value });
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2"
          >
            <option value={ALL_OPERATORS}>Все операторы</option>
            {operators.map((operator) => (
              <option key={operator.operator_id} value={operator.operator_id}>
                {operator.operator_name}
              </option>
            ))}
          </select>
        </DialogField>

        <DialogField label="Через что">
          <select
            value={draft.terminationKind}
            onChange={(event) => {
              setDraft({ ...draft, terminationKind: event.target.value as TerminationKind });
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2"
          >
            {TERMINATION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {TERMINATION_KIND_NAME[kind]}
              </option>
            ))}
          </select>
        </DialogField>

        <DialogField label="Регион" wide>
          <Input
            value={draft.region}
            placeholder="любой"
            autoComplete="off"
            onChange={(event) => {
              setDraft({ ...draft, region: event.target.value });
            }}
          />
        </DialogField>

        <DialogField label="За минуту">
          <Input
            required
            className="num"
            inputMode="decimal"
            autoComplete="off"
            value={draft.pricePerMinute}
            onChange={(event) => {
              setDraft({ ...draft, pricePerMinute: event.target.value });
            }}
          />
        </DialogField>

        <DialogField label="За соединение">
          <Input
            className="num"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={draft.connectionFee}
            onChange={(event) => {
              setDraft({ ...draft, connectionFee: event.target.value });
            }}
          />
        </DialogField>

        <DialogField label="Шаг, с" hint="1 — посекундно, 60 — поминутно">
          <Input
            type="number"
            className="num"
            min={1}
            max={3600}
            value={draft.billingIncrementSeconds}
            onChange={(event) => {
              setDraft({ ...draft, billingIncrementSeconds: event.target.value });
            }}
          />
        </DialogField>

        <DialogField label="Минимум, с">
          <Input
            type="number"
            className="num"
            min={0}
            max={3600}
            value={draft.minimumDurationSeconds}
            onChange={(event) => {
              setDraft({ ...draft, minimumDurationSeconds: event.target.value });
            }}
          />
        </DialogField>

        <BandNote everyone={everyone} chosen={chosen} bandsEnabled={bandsEnabled} />

        {save.error !== null && (
          <div className="sm:col-span-2">
            <Refusal error={save.error} />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
        <Button
          type="submit"
          size="sm"
          aria-disabled={save.isPending}
          className="aria-disabled:opacity-50"
        >
          {save.isPending ? 'Назначаем…' : 'Назначить цену'}
        </Button>
        <DialogClose asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={save.isPending}
            className="aria-disabled:opacity-50"
          >
            Отмена
          </Button>
        </DialogClose>
      </div>
    </form>
  );
}

/**
 * Рамки цены рядом с полем — только когда они есть: коридор выбранного оператора.
 * У цены «на все операторы» рамки назовёт отказ, с числами (владелец, 2026-09-30:
 * «зачем эта информация, если и так всё понятно»).
 */
function BandNote({
  everyone,
  chosen,
  bandsEnabled,
}: {
  everyone: boolean;
  chosen: OperatorChoice | undefined;
  bandsEnabled: boolean;
}) {
  if (!bandsEnabled || everyone || chosen?.min_price == null || chosen.max_price == null) {
    return null;
  }
  return (
    <p className="text-muted-foreground sm:col-span-2">
      Коридор: {money(chosen.min_price)} — {money(chosen.max_price)} за вызов 60 с
    </p>
  );
}

/**
 * Отказ по цене — с числами, а не общими словами.
 *
 * У «вне коридора» площадка возвращает стоимость эталонного вызова и обе границы:
 * без них человек видит «2 рубля не помещаются в коридор от 1 до 3» и не понимает,
 * при чём тут плата за соединение.
 */
function Refusal({ error }: { error: Error }) {
  if (!(error instanceof ApiError)) {
    return (
      <p role="alert" className="text-crit">
        {error.message}
      </p>
    );
  }

  const cost = text(error.details['reference_cost']);
  const min = text(error.details['min_price']);
  const max = text(error.details['max_price']);
  const remedy = text(error.details['remedy']);

  return (
    <div role="alert" className="flex flex-col gap-0.5">
      <span className="text-crit">{error.message}</span>
      {cost !== undefined && min !== undefined && max !== undefined && (
        <span className="text-muted-foreground">
          Вызов в 60 секунд по этому тарифу стоит {money(cost)}, а коридор — от {money(min)} до{' '}
          {money(max)}.
        </span>
      )}
      {remedy !== undefined && <span className="text-muted-foreground">{remedy}</span>}
      {error.problems.map((problem) => (
        <span key={problem} className="text-muted-foreground">
          {problem}
        </span>
      ))}
    </div>
  );
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
