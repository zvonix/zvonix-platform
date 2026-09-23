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

/**
 * Направление, открытое площадкой, — как его отдаёт `GET /partner/rates`.
 *
 * Здесь только те, по которым коридор задан: чего в списке нет, того и назначить
 * нельзя. Рамки — **общие** для направления; если по региону задан свой коридор,
 * точные числа придут в отказе.
 */
interface Direction {
  readonly operator_id: string;
  readonly operator_name: string;
  readonly min_price: string;
  readonly max_price: string;
}

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
  operatorId: '',
  terminationKind: 'sim',
  region: '',
  pricePerMinute: '',
  connectionFee: '',
  billingIncrementSeconds: '1',
  minimumDurationSeconds: '0',
};

/**
 * Назначение своей цены — первое, что партнёр в этой площадке меняет сам.
 *
 * Коридор стоит **рядом с полем**, а не в отказе после отправки: без рамок человек
 * вводит число вслепую ([ADR-0023](../../../../../../docs/adr/0023-koridory-cen.md)).
 * Направление без коридора здесь не выбирается вовсе — площадка его ещё не открыла,
 * и назначить там цену нельзя ни партнёру, ни через форму.
 *
 * Стоимость эталонного вызова не считается в браузере: кабинет деньги показывает,
 * а не вычисляет ([money.ts](../../../lib/money.ts)). Когда тариф не помещается
 * в коридор, точные числа приходят в отказе — считает их та же функция, которой
 * тарифицируется настоящий вызов.
 */
export function SetPrice({ directions }: { directions: readonly Direction[] }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <div className="flex flex-wrap items-baseline gap-3">
      <FormDialog
        label="Назначить цену"
        title="Назначить цену"
        description="Цена начинает действовать сразу и не переоценивает прошлое."
        variant="outline"
        disabled={directions.length === 0}
        open={open}
        onOpenChange={(next) => {
          // Пока цена отправляется, окно не закрывается: иначе ответ пришёл бы в пустоту.
          if (!pending) setOpen(next);
        }}
      >
        <PriceForm
          directions={directions}
          onPending={setPending}
          onSaved={() => {
            setOpen(false);
          }}
        />
      </FormDialog>
      {directions.length === 0 && (
        <span className="text-muted-foreground">
          Площадка не открыла ни одного направления с коридором цен — назначать цену пока не по
          чему.
        </span>
      )}
    </div>
  );
}

/**
 * Поля окна «Назначить цену».
 *
 * Не `DialogForm`: отказ по коридору показывается с числами ({@link Refusal}), а общая
 * строка отказа окна их не знает.
 */
function PriceForm({
  directions,
  onPending,
  onSaved,
}: {
  directions: readonly Direction[];
  onPending: (pending: boolean) => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const chosen = directions.find((direction) => direction.operator_id === draft.operatorId);

  const save = useMutation({
    mutationFn: () =>
      request<{ rate: { id: string } }>('/partner/rates', {
        method: 'POST',
        body: {
          operatorId: draft.operatorId,
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
      void queryClient.invalidateQueries({ queryKey: ['partner', 'rates'] });
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
        <DialogField label="Оператор">
          <select
            required
            autoFocus
            value={draft.operatorId}
            onChange={(event) => {
              setDraft({ ...draft, operatorId: event.target.value });
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2"
          >
            <option value="">выберите</option>
            {directions.map((direction) => (
              <option key={direction.operator_id} value={direction.operator_id}>
                {direction.operator_name}
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

        <DialogField label="Шаг, с">
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

        {chosen !== undefined && (
          <p className="text-muted-foreground sm:col-span-2">
            Коридор по этому направлению: {money(chosen.min_price)} — {money(chosen.max_price)}.
            Сравнивается не цена за минуту, а стоимость вызова в 60 секунд по всему тарифу — плата
            за соединение и минимальная длительность входят в неё. Если по региону задан свой
            коридор, он строже этого, и точные числа придут в отказе.
          </p>
        )}

        {save.error !== null && (
          <div className="sm:col-span-2">
            <Refusal error={save.error} />
          </div>
        )}

        <p className="text-muted-foreground sm:col-span-2">
          Цена начинает действовать сразу и не переоценивает прошлое: прежняя строка остаётся в
          истории, а вызовы, тарифицированные по ней, пересчитаны не будут. В списке — только
          направления, открытые площадкой: по остальным цену не назначить, и просить её об этом
          нужно отдельно.
        </p>
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
