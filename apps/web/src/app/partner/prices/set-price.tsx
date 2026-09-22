'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TERMINATION_KINDS, type TerminationKind } from '@zvonix/shared';
import { useState } from 'react';
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
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [open, setOpen] = useState(false);

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
    onSuccess: () => {
      setDraft(EMPTY);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['partner', 'rates'] });
    },
  });

  if (!open) {
    return (
      <div className="flex flex-wrap items-baseline gap-3">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
          disabled={directions.length === 0}
          className="rounded-md border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
        >
          Назначить цену
        </button>
        {directions.length === 0 && (
          <span className="text-muted-foreground">
            Площадка не открыла ни одного направления с коридором цен — назначать цену пока не по
            чему.
          </span>
        )}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="font-semibold">Назначить цену</h3>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Оператор</span>
          <select
            required
            value={draft.operatorId}
            onChange={(event) => {
              setDraft({ ...draft, operatorId: event.target.value });
            }}
            className="h-9 w-[240px] rounded-md border border-input bg-transparent px-2"
          >
            <option value="">выберите</option>
            {directions.map((direction) => (
              <option key={direction.operator_id} value={direction.operator_id}>
                {direction.operator_name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Через что</span>
          <select
            value={draft.terminationKind}
            onChange={(event) => {
              setDraft({ ...draft, terminationKind: event.target.value as TerminationKind });
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
          <span className="text-muted-foreground">Регион</span>
          <input
            value={draft.region}
            placeholder="любой"
            onChange={(event) => {
              setDraft({ ...draft, region: event.target.value });
            }}
            className="h-9 w-[190px] rounded-md border border-input bg-transparent px-2"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">За минуту</span>
          <input
            required
            inputMode="decimal"
            value={draft.pricePerMinute}
            onChange={(event) => {
              setDraft({ ...draft, pricePerMinute: event.target.value });
            }}
            className="num h-9 w-[120px] rounded-md border border-input bg-transparent px-2"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">За соединение</span>
          <input
            inputMode="decimal"
            placeholder="0"
            value={draft.connectionFee}
            onChange={(event) => {
              setDraft({ ...draft, connectionFee: event.target.value });
            }}
            className="num h-9 w-[120px] rounded-md border border-input bg-transparent px-2"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Шаг, с</span>
          <input
            type="number"
            min={1}
            max={3600}
            value={draft.billingIncrementSeconds}
            onChange={(event) => {
              setDraft({ ...draft, billingIncrementSeconds: event.target.value });
            }}
            className="num h-9 w-[90px] rounded-md border border-input bg-transparent px-2"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Минимум, с</span>
          <input
            type="number"
            min={0}
            max={3600}
            value={draft.minimumDurationSeconds}
            onChange={(event) => {
              setDraft({ ...draft, minimumDurationSeconds: event.target.value });
            }}
            className="num h-9 w-[90px] rounded-md border border-input bg-transparent px-2"
          />
        </label>
      </div>

      {chosen !== undefined && (
        <p className="text-muted-foreground">
          Коридор по этому направлению: {money(chosen.min_price)} — {money(chosen.max_price)}.
          Сравнивается не цена за минуту, а стоимость вызова в 60 секунд по всему тарифу — плата за
          соединение и минимальная длительность входят в неё. Если по региону задан свой коридор, он
          строже этого, и точные числа придут в отказе.
        </p>
      )}

      {save.error !== null && <Refusal error={save.error} />}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-md bg-rail px-3 py-1 text-rail-ink hover:bg-rail-active disabled:opacity-50"
        >
          Назначить
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            save.reset();
          }}
          className="rounded-md border border-border px-3 py-1 hover:bg-muted"
        >
          Отмена
        </button>
      </div>

      <p className="text-muted-foreground">
        Цена начинает действовать сразу и не переоценивает прошлое: прежняя строка остаётся в
        истории, а вызовы, тарифицированные по ней, пересчитаны не будут. В списке — только
        направления, открытые площадкой: по остальным цену не назначить, и просить её об этом нужно
        отдельно.
      </p>
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
