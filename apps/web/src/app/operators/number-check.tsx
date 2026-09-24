'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { useStaffOperators } from './operators';

interface Brief {
  readonly id: string;
  readonly name: string;
}

/** Ответ `GET` и `PUT /numbers/:msisdn/operator`. */
interface Resolution {
  readonly range_owner: Brief | null;
  readonly serving: Brief | null;
  readonly network: Brief | null;
  readonly region: string | null;
  readonly source: 'lookup' | 'numbering_plan' | 'manual' | null;
  readonly confirmed: boolean;
}

const SOURCE_NAME: Record<NonNullable<Resolution['source']>, string> = {
  lookup: 'служба проверки перенесённых номеров',
  numbering_plan: 'план нумерации — кому выдан диапазон',
  manual: 'подтверждён администратором',
};

/** Номер в том виде, в каком его ждёт путь API: только цифры. */
const digitsOf = (value: string): string => value.replace(/\D/gu, '');

/**
 * Проверка номера: кому выдан диапазон, кто обслуживает сейчас и подтверждено ли это.
 *
 * Отсюда же — ручное подтверждение, когда служба проверки недоступна, а номер проверен
 * иначе. Без подтверждения по номеру не звонят вовсе (ADR-0013), поэтому экран говорит
 * это прямо, а не показывает «оператор: МТС» у неподтверждённой записи.
 */
export function NumberCheck() {
  const [value, setValue] = useState('');
  const check = useMutation({
    mutationFn: (msisdn: string) =>
      request<Resolution>(`/numbers/${encodeURIComponent(msisdn)}/operator`),
  });
  const msisdn = digitsOf(value);
  const error = check.error instanceof ApiError ? check.error : undefined;

  return (
    <section aria-labelledby="number-check" className="flex max-w-[720px] flex-col gap-3">
      <h2 id="number-check" className="font-semibold">
        Проверка номера
      </h2>
      <p className="text-muted-foreground">
        Звонок проходит, только если оператор номера подтверждён. Проверьте номер — набираемый или
        номер SIM партнёра.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (msisdn !== '') check.mutate(msisdn);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="msisdn">Номер</Label>
          <Input
            id="msisdn"
            className="num w-[220px]"
            inputMode="tel"
            autoComplete="off"
            spellCheck={false}
            placeholder="+7 913 042-41-23"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </div>
        <Button type="submit" variant="outline" disabled={msisdn === '' || check.isPending}>
          {check.isPending ? 'Проверяем…' : 'Проверить'}
        </Button>
      </form>

      {error !== undefined && <ErrorNote error={error} />}
      {check.data !== undefined && (
        <ResolutionCard
          msisdn={check.variables}
          resolution={check.data}
          onConfirmed={(next) => {
            check.reset();
            check.mutate(next);
          }}
        />
      )}
    </section>
  );
}

function ResolutionCard({
  msisdn,
  resolution,
  onConfirmed,
}: {
  msisdn: string;
  resolution: Resolution;
  onConfirmed: (msisdn: string) => void;
}) {
  const canChange = useCanChange();
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Номер</dt>
        <dd className="num">{msisdn}</dd>
        <dt className="text-muted-foreground">Диапазон выдан</dt>
        <dd>{resolution.range_owner?.name ?? 'нет в плане нумерации'}</dd>
        <dt className="text-muted-foreground">Обслуживает сейчас</dt>
        <dd>{resolution.serving?.name ?? 'неизвестно'}</dd>
        {resolution.region !== null && (
          <>
            <dt className="text-muted-foreground">Регион</dt>
            <dd>{resolution.region}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Откуда</dt>
        <dd>{resolution.source === null ? '—' : SOURCE_NAME[resolution.source]}</dd>
      </dl>
      <p className={resolution.confirmed ? 'text-ok' : 'text-warn'}>
        {resolution.confirmed
          ? 'Оператор подтверждён — по номеру звонят.'
          : 'Оператор не подтверждён — по этому номеру не звонят.'}
      </p>
      {canChange && (
        <div>
          <ConfirmOperator
            msisdn={msisdn}
            suggested={resolution.serving?.id ?? resolution.range_owner?.id ?? ''}
            onConfirmed={onConfirmed}
          />
        </div>
      )}
    </div>
  );
}

/** Ручное подтверждение: оператор предлагается тот, кого назвал план или источник. */
function ConfirmOperator({
  msisdn,
  suggested,
  onConfirmed,
}: {
  msisdn: string;
  suggested: string;
  onConfirmed: (msisdn: string) => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useMutation({
    mutationFn: (operatorId: string) =>
      request<Resolution>(`/numbers/${encodeURIComponent(msisdn)}/operator`, {
        method: 'PUT',
        body: { operatorId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['audit'] });
      onConfirmed(msisdn);
    },
  });

  return (
    <FormDialog
      label="Подтвердить оператора вручную"
      title={`Оператор номера ${msisdn}`}
      description="Действие попадёт в журнал с вашим именем."
      variant="outline"
    >
      <ConfirmOperatorForm suggested={suggested} onConfirm={(id) => confirm.mutateAsync(id)} />
    </FormDialog>
  );
}

function ConfirmOperatorForm({
  suggested,
  onConfirm,
}: {
  suggested: string;
  onConfirm: (operatorId: string) => Promise<unknown>;
}) {
  const operators = useStaffOperators();
  const [operatorId, setOperatorId] = useState(suggested);

  return (
    <DialogForm
      submitLabel="Подтвердить оператора"
      canSubmit={operatorId !== ''}
      onSubmit={() => onConfirm(operatorId)}
    >
      <DialogField label="Оператор" wide>
        <select
          value={operatorId}
          disabled={operators.data === undefined}
          onChange={(event) => {
            setOperatorId(event.target.value);
          }}
          className="h-9 w-full rounded-md border border-input bg-transparent px-2"
        >
          <option value="">{operators.data === undefined ? 'загружаем…' : 'выберите'}</option>
          {operators.data?.map((operator) => (
            <option key={operator.id} value={operator.id}>
              {operator.name}
            </option>
          ))}
        </select>
      </DialogField>
      <p className="text-muted-foreground sm:col-span-2">
        Подтверждайте, только если убедились: например, позвонили с этого номера или спросили у
        абонента. Если номер на деле у другого оператора, звонок уйдёт в чужую сеть за счёт
        партнёра. Подтверждение действует столько же, сколько ответ службы проверки, и заменится её
        ответом, когда она станет доступна.
      </p>
    </DialogForm>
  );
}
