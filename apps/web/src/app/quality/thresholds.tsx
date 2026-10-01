'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { Input } from '@/components/ui/input';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';

interface Threshold {
  readonly scope: 'sim' | 'gateway';
  readonly failures: number;
  readonly window_minutes: number;
}

const SCOPES = [
  { scope: 'sim', name: 'SIM' },
  { scope: 'gateway', name: 'Шлюз' },
] as const;

const KEY = ['failure-thresholds'] as const;

/**
 * Автоотключение по отказам сети (ADR-0027). Считаются только отказы сети — не «не ответил»
 * и не причины платформы; доля состоявшихся на отключение не влияет. Вернуть объект в
 * строй может только администратор.
 */
export function Thresholds() {
  const canChange = useCanChange();
  const list = useQuery({
    queryKey: KEY,
    queryFn: () => request<{ thresholds: Threshold[] }>('/failure-thresholds'),
  });
  const error = list.error instanceof ApiError ? list.error : undefined;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold">Автоотключение при отказах сети</h2>
      {error !== undefined && <ErrorNote error={error} />}
      {list.data !== undefined && (
        <ul className="flex flex-col gap-2">
          {SCOPES.map(({ scope, name }) => (
            <ThresholdLine
              key={scope}
              scope={scope}
              name={name}
              current={list.data.thresholds.find((entry) => entry.scope === scope)}
              canChange={canChange}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ThresholdLine({
  scope,
  name,
  current,
  canChange,
}: {
  scope: Threshold['scope'];
  name: string;
  current: Threshold | undefined;
  canChange: boolean;
}) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  const [failures, setFailures] = useState(String(current?.failures ?? 10));
  const [minutes, setMinutes] = useState(String(current?.window_minutes ?? 60));

  const remove = useMutation({
    mutationFn: () => request<unknown>(`/failure-thresholds/${scope}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
      <span className="w-14 font-semibold">{name}</span>
      <span className="flex-1">
        {current === undefined ? (
          <span className="text-muted-foreground">не отключается автоматически</span>
        ) : (
          <>
            отключается при <b className="num">{current.failures}</b> отказах сети за{' '}
            <b className="num">{current.window_minutes}</b> мин
          </>
        )}
      </span>
      {canChange && (
        <div className="flex flex-wrap gap-2">
          <FormDialog
            label={current === undefined ? 'Включить' : 'Изменить'}
            title={`Порог отключения: ${name}`}
            variant="outline"
            size="sm"
          >
            <DialogForm
              submitLabel="Сохранить"
              canSubmit={Number(failures) >= 2 && Number(minutes) >= 1}
              onSubmit={async () => {
                await request<unknown>(`/failure-thresholds/${scope}`, {
                  method: 'PUT',
                  body: { failures: Number(failures), windowMinutes: Number(minutes) },
                });
                await refresh();
              }}
            >
              <DialogField label="Отказов сети (не меньше 2)">
                <Input
                  type="number"
                  min={2}
                  inputMode="numeric"
                  value={failures}
                  onChange={(event) => {
                    setFailures(event.target.value);
                  }}
                />
              </DialogField>
              <DialogField label="За сколько минут">
                <Input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={minutes}
                  onChange={(event) => {
                    setMinutes(event.target.value);
                  }}
                />
              </DialogField>
            </DialogForm>
          </FormDialog>
          {current !== undefined && (
            <ConfirmAction
              label="Снять"
              title={`Снять порог: ${name}`}
              consequence={
                <p>
                  Автоматического отключения не будет. Уже отключённые объекты в строй сами не
                  вернутся.
                </p>
              }
              confirmLabel="Снять порог"
              onConfirm={() => remove.mutateAsync()}
            />
          )}
        </div>
      )}
    </li>
  );
}
