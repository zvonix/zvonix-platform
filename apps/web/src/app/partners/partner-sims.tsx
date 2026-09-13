'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SIM_STATUSES, USABLE_SIM_STATUSES, type SimStatus } from '@zvonix/shared';
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
import { ApiError, request } from '@/lib/api';
import { useOperators } from '@/lib/dictionaries';
import { moment } from '@/lib/format';
import { SIM_STATUS_NAME, usableTone } from '@/lib/labels';

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
 * SIM партнёра.
 *
 * Объявленный оператор сверяется с ответом резолвера по собственному номеру SIM:
 * подтверждённое расхождение — **отказ**, а не предупреждение
 * ([ADR-0013](../../../../../docs/adr/0013-opredelenie-operatora.md)). У всех партнёров
 * тариф «безлимит внутри своей сети»: верный оператор — звонок бесплатен, неверный —
 * деньги партнёра, промежуточного варианта нет.
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

  const changeStatus = useMutation({
    mutationFn: (input: { id: string; status: SimStatus }) =>
      request<unknown>(`/sim-cards/${input.id}/status`, {
        method: 'POST',
        body: { status: input.status },
      }),
    onSuccess: invalidate,
  });

  const changeConcurrency = useMutation({
    mutationFn: (input: { id: string; value: string }) =>
      request<unknown>(`/sim-cards/${input.id}/concurrency`, {
        method: 'POST',
        body: { maxConcurrentCalls: input.value },
      }),
    onSuccess: invalidate,
  });

  const failed = [declare.error, changeStatus.error, changeConcurrency.error, error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );
  const ready = operatorId !== '' && msisdn.trim() !== '';

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
            <span className="text-muted-foreground">Номер SIM</span>
            <Input
              className="num w-[180px]"
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
              value={iccid}
              placeholder="необязательно"
              onChange={(event) => {
                setIccid(event.target.value);
              }}
            />
          </label>

          <Button type="submit" size="sm" disabled={!ready || declare.isPending}>
            Объявить
          </Button>

          <p className="w-full text-muted-foreground">
            Оператор сверяется с ответом справочника по самому номеру SIM. Расхождение — отказ: у
            партнёра безлимит только внутри своей сети, и звонок с неверно объявленной SIM
            оплачивает он сам.
          </p>
        </form>
      )}

      {failed !== undefined && (
        <p role="alert" className="text-crit">
          {failed.message}
        </p>
      )}

      <div className="max-w-[900px] rounded-md border border-border bg-card">
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
                  {/*
                    Одновременность на SIM держится блокировкой в транзакции. Больше
                    единицы ставит только администратор: оператор может посчитать это
                    признаком шлюза и заблокировать SIM.
                  */}
                  {canChange ? (
                    <Input
                      className="num h-8 w-[70px] text-right"
                      defaultValue={String(sim.max_concurrent_calls)}
                      onBlur={(event) => {
                        const value = event.target.value.trim();
                        if (value !== String(sim.max_concurrent_calls) && value !== '') {
                          changeConcurrency.mutate({ id: sim.id, value });
                        }
                      }}
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
                  <div className="flex flex-wrap gap-1">
                    {canChange &&
                      SIM_STATUSES.filter((status) => status !== sim.status).map((status) => (
                        <Button
                          key={status}
                          variant="outline"
                          size="sm"
                          disabled={changeStatus.isPending}
                          onClick={() => {
                            changeStatus.mutate({ id: sim.id, status });
                          }}
                        >
                          {SIM_STATUS_NAME[status]}
                        </Button>
                      ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
