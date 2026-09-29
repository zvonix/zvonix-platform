'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MAX_CONCURRENT_CALLS_LIMIT,
  SIM_STATUSES,
  USABLE_SIM_STATUSES,
  type SimStatus,
} from '@zvonix/shared';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { StatusDialog } from '@/components/status-dialog';
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
 * ([ADR-0013](../../../../../docs/adr/0013-opredelenie-operatora.md)). Куда карта звонит,
 * решает её тариф, а не её оператор
 * ([ADR-0056](../../../../../docs/adr/0056-tarify-partnyora.md)).
 *
 * Состояние меняется окном с вариантами (`StatusDialog`): последствие перехода видно
 * до нажатия. Раньше «Выведена» срабатывала с первого нажатия (ui-review, 2026-09-14),
 * а потом у каждой строки стояло по четыре кнопки переходов.
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

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['sim-cards', partnerId] });
  };

  const declare = useMutation({
    mutationFn: (draft: SimDraft) =>
      request<unknown>('/sim-cards', { method: 'POST', body: { partnerId, ...draft } }),
    onSuccess: invalidate,
  });

  // Отказ перевода виден в окне состояния и не повторяется в общей строке ошибок.
  const changeStatus = useMutation({
    mutationFn: (input: { id: string; status: SimStatus }) =>
      request<unknown>(`/sim-cards/${input.id}/status`, {
        method: 'POST',
        body: { status: input.status },
      }),
    onSuccess: () => atMost(invalidate()),
  });

  // Отказы объявления и перевода показывают их окна, здесь — только отказ списка.
  const failed = asApiError(error);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h3 className="font-semibold">SIM-карты</h3>
        {canChange && (
          <FormDialog label="Объявить SIM" title="Новая SIM" variant="outline">
            <DeclareSimForm onDeclare={(draft) => declare.mutateAsync(draft)} />
          </FormDialog>
        )}
      </div>

      {failed !== undefined && <ErrorNote error={failed} />}

      <div className="overflow-x-auto rounded-md border border-border bg-card">
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
                    <ConcurrencyField sim={sim} onSaved={invalidate} />
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
                    <StatusDialog
                      subject={`SIM ${sim.msisdn}`}
                      current={SIM_STATUS_NAME[sim.status]}
                      options={SIM_STATUSES.filter((status) => status !== sim.status).map(
                        (status) => ({
                          value: status,
                          action: STATUS_ACTION[status],
                          meaning: SIM_STATUS_MEANING[status],
                          danger: status === 'blocked' || status === 'retired',
                        }),
                      )}
                      onChange={(status) => changeStatus.mutateAsync({ id: sim.id, status })}
                    />
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

interface SimDraft {
  readonly operatorId: string;
  readonly msisdn: string;
  readonly iccid?: string;
}

/** Объявление SIM — поля окна «Новая SIM». */
function DeclareSimForm({ onDeclare }: { onDeclare: (draft: SimDraft) => Promise<unknown> }) {
  const operators = useOperators();
  const [operatorId, setOperatorId] = useState('');
  const [msisdn, setMsisdn] = useState('');
  const [iccid, setIccid] = useState('');

  return (
    <DialogForm
      submitLabel="Объявить SIM"
      canSubmit={operatorId !== '' && msisdn.trim() !== ''}
      onSubmit={() =>
        onDeclare({
          operatorId,
          msisdn,
          ...(iccid.trim() === '' ? {} : { iccid: iccid.trim() }),
        })
      }
    >
      <DialogField label="Оператор">
        <select
          value={operatorId}
          disabled={!operators.ready}
          onChange={(event) => {
            setOperatorId(event.target.value);
          }}
          className="h-9 rounded-md border border-input bg-transparent px-2"
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
      </DialogField>

      <DialogField label="Номер SIM">
        <Input
          className="num"
          inputMode="tel"
          autoComplete="off"
          spellCheck={false}
          value={msisdn}
          placeholder="+7 916 123-45-67"
          onChange={(event) => {
            setMsisdn(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="ICCID" wide>
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={iccid}
          placeholder="необязательно"
          onChange={(event) => {
            setIccid(event.target.value);
          }}
        />
      </DialogField>

      <p className="text-muted-foreground sm:col-span-2">
        Оператор сверяется с ответом справочника по самому номеру SIM. Расхождение — отказ: у
        партнёра безлимит только внутри своей сети, и звонок с неверно объявленной SIM оплачивает он
        сам.
      </p>
    </DialogForm>
  );
}

/**
 * «Вызовов разом» — число в строке и окно правки, а не отправка по потере фокуса.
 *
 * Раньше значение уходило молча, когда фокус покидал поле: без подписи, без итога,
 * а после отказа поле продолжало показывать отвергнутое число. Одновременность на SIM
 * держится блокировкой в транзакции, и больше единицы ставит только администратор:
 * оператор может принять такую SIM за шлюз и заблокировать её — это сказано на экране,
 * а не только в коде.
 */
function ConcurrencyField({ sim, onSaved }: { sim: Sim; onSaved: () => Promise<void> }) {
  const save = useMutation({
    mutationFn: (next: number) =>
      request<unknown>(`/sim-cards/${sim.id}/concurrency`, {
        method: 'POST',
        body: { maxConcurrentCalls: next },
      }),
    onSuccess: onSaved,
  });

  return (
    <div className="flex items-center justify-end gap-2">
      <span className="num">{sim.max_concurrent_calls}</span>
      <FormDialog
        label="Изменить"
        title={`Вызовов разом на SIM ${sim.msisdn}`}
        variant="outline"
        size="xs"
      >
        <ConcurrencyForm sim={sim} onSave={(next) => save.mutateAsync(next)} />
      </FormDialog>
    </div>
  );
}

function ConcurrencyForm({
  sim,
  onSave,
}: {
  sim: Sim;
  onSave: (next: number) => Promise<unknown>;
}) {
  const [value, setValue] = useState(String(sim.max_concurrent_calls));

  const parsed = integerFromInput(value);
  const valid = parsed !== undefined && parsed >= 1 && parsed <= MAX_CONCURRENT_CALLS_LIMIT;
  const dirty = valid && parsed !== sim.max_concurrent_calls;

  return (
    <DialogForm
      submitLabel="Сохранить"
      canSubmit={dirty}
      onSubmit={() => onSave(parsed ?? sim.max_concurrent_calls)}
    >
      <DialogField
        label="Вызовов разом"
        hint={valid ? undefined : `Целое число от 1 до ${String(MAX_CONCURRENT_CALLS_LIMIT)}.`}
      >
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </DialogField>
      {valid && parsed > 1 && (
        <p className="text-warn sm:col-span-2">
          Больше одного: оператор может принять SIM за шлюз и заблокировать её.
        </p>
      )}
    </DialogForm>
  );
}
