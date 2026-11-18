'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MAX_CONCURRENT_CALLS_LIMIT,
  SIM_STATUSES,
  USABLE_SIM_STATUSES,
  type SimStatus,
} from '@zvonix/shared';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { paceSummary, warmupCell, type NumberPaceView } from '@/components/number-pace';
import { StatusDialog } from '@/components/status-dialog';
import { HintText, StatusDot, toneOf } from '@/components/status-dot';
import { HEAD, NUM, RowActions, ROW_ICON, TABLE_FRAME, WIDE_ONLY } from '@/components/table-parts';
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
  /** Прогрев и рекомендованная работа номера (ADR-0105). */
  readonly pace?: NumberPaceView;
}

const COLUMNS = 6;

/**
 * Кнопка называет **действие**, а не состояние: четыре кнопки «Заблокирована»,
 * «Выведена»… рядом с плашкой текущего состояния читались как плашки, а не кнопки.
 */
const STATUS_ACTION: Record<SimStatus, string> = {
  new: 'Вернуть в «новая»',
  active: 'Включить',
  // Не предлагается: «выключена» — решение самого партнёра, у площадки для этого «Придержать» (ADR-0112).
  paused: 'Выключить',
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
          <FormDialog label="Добавить SIM" title="Новая SIM" variant="outline">
            <DeclareSimForm onDeclare={(draft) => declare.mutateAsync(draft)} />
          </FormDialog>
        )}
      </div>

      {failed !== undefined && <ErrorNote error={failed} />}

      <div className={TABLE_FRAME}>
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className={HEAD}>Номер SIM</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Оператор</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Прогрев</TableHead>
              <TableHead className={HEAD}>Состояние</TableHead>
              <TableHead className={`${HEAD} text-right ${WIDE_ONLY}`}>Вызовов разом</TableHead>
              <TableHead className={`${HEAD} w-px`}>
                <span className="sr-only">Действия</span>
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
                  {/* ICCID — в подсказке к номеру: строка в одну линию (DESIGN.md, «Таблица»). */}
                  <span
                    className="num"
                    title={sim.iccid === null ? undefined : `ICCID ${sim.iccid}`}
                  >
                    {sim.msisdn}
                  </span>
                </TableCell>
                <TableCell className={WIDE_ONLY}>
                  <OperatorCell sim={sim} name={operators.nameOf(sim.operator_id)} />
                </TableCell>
                <TableCell className={WIDE_ONLY}>
                  <WarmupCell sim={sim} />
                </TableCell>
                <TableCell>
                  <SimState sim={sim} />
                </TableCell>
                <TableCell className={`${NUM} ${WIDE_ONLY}`}>{sim.max_concurrent_calls}</TableCell>
                <TableCell>
                  <RowActions>
                    {canChange && <ConcurrencyEdit sim={sim} onSaved={invalidate} />}
                    {canChange && sim.status !== 'retired' && (
                      <StatusDialog
                        subject={`SIM ${sim.msisdn}`}
                        current={SIM_STATUS_NAME[sim.status]}
                        options={SIM_STATUSES.filter(
                          (status) => status !== sim.status && status !== 'paused',
                        ).map((status) => ({
                          value: status,
                          action: STATUS_ACTION[status],
                          meaning: SIM_STATUS_MEANING[status],
                          danger: status === 'blocked' || status === 'retired',
                        }))}
                        onChange={(status) => changeStatus.mutateAsync({ id: sim.id, status })}
                      />
                    )}
                  </RowActions>
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
 * Оператор карты; не сверенный со справочником — жёлтой точкой, когда сверен — в подсказке
 * (DESIGN.md, «Таблица»: отдельный столбец «Оператор сверен» с датой в каждой строке ничего не добавлял).
 */
function OperatorCell({ sim, name }: { sim: Sim; name: string | undefined }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={name === undefined ? 'text-muted-foreground' : undefined}
        title={
          sim.operator_confirmed_at === null
            ? undefined
            : `сверен ${moment(sim.operator_confirmed_at)}`
        }
      >
        {name ?? 'неизвестен'}
      </span>
      {sim.operator_confirmed_at === null && (
        <StatusDot
          tone="warn"
          label="не сверен"
          reason="оператор ещё не сверен со справочником по номеру SIM"
          dotOnly
        />
      )}
    </span>
  );
}

/** «4/14» с подсказкой; прогретый номер — пусто. Как в «Оборудовании» партнёра. */
function WarmupCell({ sim }: { sim: Sim }) {
  const warmup = sim.status === 'active' ? warmupCell(sim.pace) : null;
  return warmup === null ? null : <HintText label={warmup.label} reason={warmup.reason} />;
}

/**
 * Состояние карты точкой и словом. У работающей вместо «работает» — то, что мешает ей звонить
 * (предел, сон, пауза: `paceSummary`), если такое есть; причина — в подсказке.
 */
function SimState({ sim }: { sim: Sim }) {
  const pace = sim.status === 'active' ? paceSummary(sim.pace) : null;
  if (pace !== null) {
    return <StatusDot tone={pace.tone} label={pace.label} reason={pace.reason} phoneDot />;
  }
  return (
    <StatusDot
      tone={toneOf(usableTone(USABLE_SIM_STATUSES.includes(sim.status)))}
      label={SIM_STATUS_NAME[sim.status]}
      reason={SIM_STATUS_MEANING[sim.status]}
      phoneDot
    />
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
      submitLabel="Добавить SIM"
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
 * «Вызовов разом» — число в своём столбце и значок правки с окном, а не отправка по потере фокуса.
 *
 * Раньше значение уходило молча, когда фокус покидал поле: без подписи, без итога,
 * а после отказа поле продолжало показывать отвергнутое число. Одновременность на SIM
 * держится блокировкой в транзакции, и больше единицы ставит только администратор:
 * оператор может принять такую SIM за шлюз и заблокировать её — это сказано на экране,
 * а не только в коде.
 */
function ConcurrencyEdit({ sim, onSaved }: { sim: Sim; onSaved: () => Promise<void> }) {
  const save = useMutation({
    mutationFn: (next: number) =>
      request<unknown>(`/sim-cards/${sim.id}/concurrency`, {
        method: 'POST',
        body: { maxConcurrentCalls: next },
      }),
    onSuccess: onSaved,
  });

  return (
    <FormDialog
      label={<Pencil aria-hidden className="size-4" />}
      tooltip="Изменить"
      {...ROW_ICON}
      title={`Вызовов разом на SIM ${sim.msisdn}`}
    >
      <ConcurrencyForm sim={sim} onSave={(next) => save.mutateAsync(next)} />
    </FormDialog>
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
