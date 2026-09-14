'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MAX_CONCURRENT_CALLS_LIMIT,
  SIM_STATUSES,
  USABLE_SIM_STATUSES,
  type SimStatus,
} from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
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
import { ApiError, request } from '@/lib/api';
import { atMost } from '@/lib/wait';
import { useOperators } from '@/lib/dictionaries';
import { moment } from '@/lib/format';
import { SIM_STATUS_MEANING, SIM_STATUS_NAME, usableTone } from '@/lib/labels';
import { integerFromInput } from '@/lib/money';

export interface Sim {
  readonly id: string;
  readonly operator_id: string;
  readonly msisdn: string;
  readonly iccid: string | null;
  readonly status: SimStatus;
  readonly max_concurrent_calls: number;
  readonly operator_confirmed_at: string | null;
}

const COLUMNS = 7;

/**
 * Кнопка называет **действие**, а не состояние: четыре кнопки «Заблокирована»,
 * «Выведена»… рядом с плашкой текущего состояния читались как плашки, а не кнопки.
 */
const STATUS_ACTION: Record<SimStatus, string> = {
  new: 'Вернуть в «новая»',
  active: 'Включить',
  throttled: 'Придержать',
  blocked: 'Заблокировать',
  retired: 'Вывести навсегда',
};

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/**
 * SIM партнёра.
 *
 * Объявленный оператор сверяется с ответом резолвера по собственному номеру SIM:
 * подтверждённое расхождение — **отказ**, а не предупреждение
 * ([ADR-0013](../../../../../docs/adr/0013-opredelenie-operatora.md)). У всех партнёров
 * тариф «безлимит внутри своей сети»: верный оператор — звонок бесплатен, неверный —
 * деньги партнёра, промежуточного варианта нет.
 *
 * Включение — одним нажатием. Всё, что выводит SIM из отбора, — через подтверждение
 * с названным последствием: раньше «Выведена» срабатывала с первого нажатия
 * (ui-review, 2026-09-14).
 */
export function PartnerSims({
  partnerId,
  sims,
  pending,
  error,
}: {
  partnerId: string;
  sims: Sim[];
  pending: boolean;
  error: Error | null;
}) {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const operators = useOperators();
  const [open, setOpen] = useState(false);
  const [operatorId, setOperatorId] = useState('');
  const [msisdn, setMsisdn] = useState('');
  const [iccid, setIccid] = useState('');

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['sim-cards', partnerId] });
  };

  const declare = useMutation({
    mutationFn: () =>
      request<unknown>('/sim-cards', {
        method: 'POST',
        body: {
          partnerId,
          operatorId,
          msisdn,
          ...(iccid.trim() === '' ? {} : { iccid: iccid.trim() }),
        },
      }),
    onSuccess: async () => {
      setOpen(false);
      setMsisdn('');
      setIccid('');
      await invalidate();
    },
  });

  const activate = useMutation({
    mutationFn: (id: string) =>
      request<unknown>(`/sim-cards/${id}/status`, {
        method: 'POST',
        body: { status: 'active' },
      }),
    onSuccess: invalidate,
  });

  // Подтверждаемый перевод — своей мутацией: отказ виден в окне подтверждения
  // и не повторяется в общей строке ошибок.
  const confirmStatus = useMutation({
    mutationFn: (input: { id: string; status: SimStatus }) =>
      request<unknown>(`/sim-cards/${input.id}/status`, {
        method: 'POST',
        body: { status: input.status },
      }),
    onSuccess: () => atMost(invalidate()),
  });

  const failed = asApiError(declare.error ?? activate.error ?? error);
  const ready = operatorId !== '' && msisdn.trim() !== '';
  const busy = activate.isPending || confirmStatus.isPending;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h3 className="font-semibold">SIM-карты</h3>
        {canChange && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? 'Отменить' : 'Объявить SIM'}
          </Button>
        )}
      </div>

      {canChange && open && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) declare.mutate();
          }}
          className="flex max-w-[900px] flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Оператор</span>
            <select
              value={operatorId}
              disabled={!operators.ready}
              onChange={(event) => {
                setOperatorId(event.target.value);
              }}
              className="h-9 w-[240px] rounded-md border border-input bg-transparent px-2"
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
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Номер SIM</span>
            <Input
              className="num w-[180px]"
              inputMode="tel"
              autoComplete="off"
              spellCheck={false}
              value={msisdn}
              placeholder="+7 916 123-45-67"
              onChange={(event) => {
                setMsisdn(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">ICCID</span>
            <Input
              className="num w-[220px]"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={iccid}
              placeholder="необязательно"
              onChange={(event) => {
                setIccid(event.target.value);
              }}
            />
          </label>

          <Button type="submit" size="sm" disabled={!ready || declare.isPending}>
            {declare.isPending ? 'Объявляем…' : 'Объявить'}
          </Button>

          <p className="w-full text-muted-foreground">
            Оператор сверяется с ответом справочника по самому номеру SIM. Расхождение — отказ: у
            партнёра безлимит только внутри своей сети, и звонок с неверно объявленной SIM
            оплачивает он сам.
          </p>
        </form>
      )}

      {failed !== undefined && <ErrorNote error={failed} />}

      <div className="max-w-[900px] overflow-x-auto rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Номер SIM</TableHead>
              <TableHead className="h-8">Оператор</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8 text-right">Вызовов разом</TableHead>
              <TableHead className="h-8">Оператор сверен</TableHead>
              <TableHead className="h-8" colSpan={2}>
                {' '}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {!pending && sims.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  SIM не объявлены — звонить не с чего.
                </TableCell>
              </TableRow>
            )}

            {sims.map((sim) => (
              <TableRow key={sim.id}>
                <TableCell>
                  <span className="num">{sim.msisdn}</span>
                  {sim.iccid !== null && <span className="num block text-faint">{sim.iccid}</span>}
                </TableCell>
                <TableCell>
                  {operators.nameOf(sim.operator_id) ?? (
                    <span className="text-muted-foreground">неизвестен</span>
                  )}
                </TableCell>
                <TableCell>
                  <span
                    className={`rounded-sm px-1.5 py-0.5 ${usableTone(
                      USABLE_SIM_STATUSES.includes(sim.status),
                    )}`}
                  >
                    {SIM_STATUS_NAME[sim.status]}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  {canChange ? (
                    <ConcurrencyField
                      key={sim.max_concurrent_calls}
                      sim={sim}
                      onSaved={invalidate}
                    />
                  ) : (
                    <span className="num">{sim.max_concurrent_calls}</span>
                  )}
                </TableCell>
                <TableCell>
                  {sim.operator_confirmed_at === null ? (
                    <span className="text-warn">не сверен</span>
                  ) : (
                    <span className="num text-muted-foreground">
                      {moment(sim.operator_confirmed_at)}
                    </span>
                  )}
                </TableCell>
                <TableCell colSpan={2}>
                  {canChange && sim.status === 'retired' && (
                    <span className="text-muted-foreground">выведена навсегда</span>
                  )}
                  {canChange && sim.status !== 'retired' && (
                    <div className="flex flex-wrap gap-1">
                      {SIM_STATUSES.filter((status) => status !== sim.status).map((status) =>
                        status === 'active' ? (
                          <Button
                            key={status}
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              activate.mutate(sim.id);
                            }}
                          >
                            {STATUS_ACTION[status]}
                          </Button>
                        ) : (
                          <ConfirmAction
                            key={status}
                            label={STATUS_ACTION[status]}
                            title={`${STATUS_ACTION[status]}: SIM ${sim.msisdn}`}
                            consequence={<p>{SIM_STATUS_MEANING[status]}</p>}
                            confirmLabel={STATUS_ACTION[status]}
                            disabled={busy}
                            onConfirm={() => confirmStatus.mutateAsync({ id: sim.id, status })}
                          />
                        ),
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * «Вызовов разом» — форма с кнопкой, а не отправка по потере фокуса.
 *
 * Раньше значение уходило молча, когда фокус покидал поле: без подписи, без итога,
 * а после отказа поле продолжало показывать отвергнутое число. Одновременность на SIM
 * держится блокировкой в транзакции, и больше единицы ставит только администратор:
 * оператор может принять такую SIM за шлюз и заблокировать её — это сказано на экране,
 * а не только в коде.
 */
function ConcurrencyField({ sim, onSaved }: { sim: Sim; onSaved: () => Promise<void> }) {
  const [value, setValue] = useState(String(sim.max_concurrent_calls));

  const save = useMutation({
    mutationFn: (next: number) =>
      request<unknown>(`/sim-cards/${sim.id}/concurrency`, {
        method: 'POST',
        body: { maxConcurrentCalls: next },
      }),
    onSuccess: onSaved,
  });

  const parsed = integerFromInput(value);
  const valid = parsed !== undefined && parsed >= 1 && parsed <= MAX_CONCURRENT_CALLS_LIMIT;
  const dirty = valid && parsed !== sim.max_concurrent_calls;
  const error = asApiError(save.error);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) save.mutate(parsed);
      }}
      className="flex flex-col items-end gap-1"
    >
      <div className="flex items-center gap-1">
        <Input
          aria-label={`Вызовов разом на ${sim.msisdn}`}
          className="num h-8 w-[60px] text-right"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            save.reset();
          }}
        />
        <Button type="submit" variant="outline" size="sm" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Сохраняем…' : 'Сохранить'}
        </Button>
      </div>
      {!valid && <span className="text-warn">целое от 1 до {MAX_CONCURRENT_CALLS_LIMIT}</span>}
      {dirty && parsed > 1 && (
        <span className="max-w-[240px] text-right text-warn">
          Больше одного: оператор может принять SIM за шлюз и заблокировать её.
        </span>
      )}
      {error !== undefined && <ErrorNote error={error} />}
    </form>
  );
}
