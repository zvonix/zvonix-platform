'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LIMIT_METRICS,
  LIMIT_PERIOD_START_DAY_MAX,
  LIMIT_WINDOWS,
  type LimitMetric,
  type LimitRounding,
  type LimitSetBy,
  type LimitWindow,
} from '@zvonix/shared';
import { Fragment, useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';
import { moment, plural } from '@/lib/format';
import { LIMIT_WINDOW_NAME, limitRuleNote } from '@/lib/labels';

/** Строка `GET /partner/limits` — правило вместе с израсходованным (ADR-0057). */
interface LimitRow {
  readonly id: string;
  readonly partner_id: string | null;
  readonly sim_card_id: string | null;
  readonly window: LimitWindow;
  readonly metric: LimitMetric;
  readonly value: number;
  readonly per_sim: boolean;
  readonly rounding: LimitRounding;
  readonly period_start_day: number | null;
  readonly set_by: LimitSetBy;
  readonly usage_sim_card_id: string | null;
  readonly resets_at: string;
  /** В единицах хранения: звонки — штуками, минуты — секундами. */
  readonly used: number;
  readonly limit: number;
  readonly exceeded: boolean;
}

interface Limits {
  readonly limits: readonly LimitRow[];
  readonly sims: readonly { readonly id: string; readonly msisdn: string }[];
}

const LIMITS_KEY = ['partner', 'limits'] as const;

type Scope = 'partner' | 'each_sim' | 'sim';

const SCOPE_NAME: Record<Scope, string> = {
  partner: 'Все карты вместе',
  each_sim: 'Каждая карта отдельно',
  sim: 'Одна карта',
};

const METRIC_FORMS: Record<LimitMetric, readonly [string, string, string]> = {
  calls: ['звонок', 'звонка', 'звонков'],
  minutes: ['минута', 'минуты', 'минут'],
};

/** «3 звонка», «500 минут» — число с единицей в нужной форме. */
function counted(metric: LimitMetric, value: number): string {
  return `${String(value)} ${plural(value, METRIC_FORMS[metric])}`;
}

export default function PartnerLimitsPage() {
  return (
    <ConsoleShell title="Лимиты" cabinet="partner">
      {() => <PartnerLimits />}
    </ConsoleShell>
  );
}

/**
 * Лимиты партнёра ([ADR-0057](../../../../../../docs/adr/0057-limity-partnyora.md)):
 * защита его карт от блокировки оператором. Остаток и момент обнуления — рядом с каждым
 * правилом; у правила «на каждую карту» — строка по каждой карте.
 */
function PartnerLimits() {
  const limits = useQuery({
    queryKey: LIMITS_KEY,
    queryFn: () => request<Limits>('/partner/limits'),
  });

  if (limits.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {limits.error.message}
      </p>
    );
  }
  if (limits.isPending) return <p className="text-muted-foreground">Загружаем…</p>;

  const { sims } = limits.data;
  const numberOf = (id: string | null) =>
    id === null ? undefined : sims.find((sim) => sim.id === id)?.msisdn;
  // Строки одного правила — подряд, чтобы правило и его действия стояли один раз.
  const groups = groupById(limits.data.limits);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <NewLimit sims={sims} />
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Лимит</TableHead>
              <TableHead className="h-8">Карты</TableHead>
              <TableHead className="hidden h-8 text-right sm:table-cell">Израсходовано</TableHead>
              <TableHead className="h-8 text-right">Осталось</TableHead>
              <TableHead className="h-8">Обнулится</TableHead>
              <TableHead className="h-8">
                <span className="sr-only">Действия</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="whitespace-normal text-muted-foreground">
                  Лимитов нет.
                </TableCell>
              </TableRow>
            )}
            {groups.map((rows) => {
              const first = rows[0];
              if (first === undefined) return null;
              return (
                <Fragment key={first.id}>
                  {rows.map((row, index) => (
                    <TableRow key={`${row.id}:${row.usage_sim_card_id ?? ''}`}>
                      {index === 0 && (
                        <TableCell rowSpan={rows.length} className="align-top whitespace-normal">
                          {counted(row.metric, row.value)} {LIMIT_WINDOW_NAME[row.window]}
                          <span className="block text-faint">{limitRuleNote(row)}</span>
                        </TableCell>
                      )}
                      <TableCell className="num">
                        {whose(row, numberOf) ?? <span className="text-faint">—</span>}
                      </TableCell>
                      <TableCell
                        className={`hidden text-right sm:table-cell num ${row.exceeded ? 'text-crit' : ''}`}
                      >
                        {amount(row.metric, row.used)}
                      </TableCell>
                      <TableCell className="num text-right">
                        {row.exceeded ? (
                          <span className="text-crit">исчерпан</span>
                        ) : (
                          amount(row.metric, row.limit - row.used)
                        )}
                      </TableCell>
                      <TableCell className="num text-muted-foreground">
                        {moment(row.resets_at)}
                      </TableCell>
                      {index === 0 && (
                        <TableCell rowSpan={rows.length} className="align-top">
                          {row.set_by === 'partner' ? (
                            <div className="flex flex-wrap justify-end gap-2">
                              <ChangeLimit row={row} />
                              <RemoveLimit row={row} />
                            </div>
                          ) : (
                            <span className="text-muted-foreground">задала площадка</span>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Строки по правилу, в порядке первого появления: одно правило — одна группа. */
function groupById(rows: readonly LimitRow[]): LimitRow[][] {
  const groups = new Map<string, LimitRow[]>();
  for (const row of rows) {
    const group = groups.get(row.id);
    if (group === undefined) groups.set(row.id, [row]);
    else group.push(row);
  }
  return [...groups.values()];
}

/** Чьи карты считает строка: все вместе, каждая (номер строки) или одна. */
function whose(
  row: LimitRow,
  numberOf: (id: string | null) => string | undefined,
): string | undefined {
  if (row.per_sim) return numberOf(row.usage_sim_card_id);
  if (row.sim_card_id !== null) return numberOf(row.sim_card_id);
  return 'все вместе';
}

/** Звонки — штуками; минуты хранятся секундами и показываются минутами с секундами. */
function amount(metric: LimitMetric, stored: number): string {
  const value = Math.max(0, stored);
  if (metric === 'calls') return String(value);
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return seconds === 0 ? `${String(minutes)} мин` : `${String(minutes)} мин ${String(seconds)} с`;
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: LIMITS_KEY });
}

function NewLimit({ sims }: { sims: Limits['sims'] }) {
  const refresh = useRefresh();
  const [scope, setScope] = useState<Scope>('each_sim');
  const [simCardId, setSimCardId] = useState('');
  const [metric, setMetric] = useState<LimitMetric>('calls');
  const [span, setSpan] = useState<LimitWindow>('day');
  const [value, setValue] = useState('');
  const [rounding, setRounding] = useState<LimitRounding>('minute');
  const [startDay, setStartDay] = useState('');

  const number = Number(value);
  const valid = Number.isInteger(number) && number >= 1 && (scope !== 'sim' || simCardId !== '');

  return (
    <FormDialog label="Добавить лимит" title="Новый лимит" variant="outline">
      <DialogForm
        submitLabel="Добавить лимит"
        canSubmit={valid}
        onSubmit={async () => {
          await request<unknown>('/partner/limits', {
            method: 'POST',
            body: {
              scope,
              ...(scope === 'sim' ? { simCardId } : {}),
              metric,
              window: span,
              value: number,
              ...(metric === 'minutes' ? { rounding } : {}),
              ...(span === 'month' && startDay !== '' ? { periodStartDay: Number(startDay) } : {}),
            },
          });
          setValue('');
          await refresh();
        }}
      >
        <DialogField label="Для каких карт">
          <select
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as Scope);
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2"
          >
            {(['each_sim', 'partner', 'sim'] as const).map((item) => (
              <option key={item} value={item}>
                {SCOPE_NAME[item]}
              </option>
            ))}
          </select>
        </DialogField>

        {scope === 'sim' ? (
          <DialogField label="Карта">
            <select
              required
              value={simCardId}
              onChange={(event) => {
                setSimCardId(event.target.value);
              }}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2"
            >
              <option value="">выберите</option>
              {sims.map((sim) => (
                <option key={sim.id} value={sim.id}>
                  {sim.msisdn}
                </option>
              ))}
            </select>
          </DialogField>
        ) : (
          <div />
        )}

        <DialogField label="Что считать">
          <select
            value={metric}
            onChange={(event) => {
              setMetric(event.target.value as LimitMetric);
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2"
          >
            {LIMIT_METRICS.map((item) => (
              <option key={item} value={item}>
                {item === 'calls' ? 'Звонки' : 'Минуты разговора'}
              </option>
            ))}
          </select>
        </DialogField>

        <DialogField label="Окно">
          <select
            value={span}
            onChange={(event) => {
              setSpan(event.target.value as LimitWindow);
            }}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2"
          >
            {LIMIT_WINDOWS.map((item) => (
              <option key={item} value={item}>
                {LIMIT_WINDOW_NAME[item]}
              </option>
            ))}
          </select>
        </DialogField>

        <DialogField label={metric === 'calls' ? 'Звонков, не больше' : 'Минут, не больше'}>
          <Input
            required
            type="number"
            className="num"
            min={1}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </DialogField>

        {metric === 'minutes' && (
          <DialogField label="Счёт минут">
            <select
              value={rounding}
              onChange={(event) => {
                setRounding(event.target.value as LimitRounding);
              }}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2"
            >
              <option value="minute">Поминутно — каждый разговор до целой минуты</option>
              <option value="second">Посекундно</option>
            </select>
          </DialogField>
        )}

        {span === 'month' && (
          <DialogField label="Пакет обновляется" hint="Пусто — первого числа">
            <Input
              type="number"
              className="num"
              min={1}
              max={LIMIT_PERIOD_START_DAY_MAX}
              placeholder="1"
              value={startDay}
              onChange={(event) => {
                setStartDay(event.target.value);
              }}
            />
          </DialogField>
        )}
      </DialogForm>
    </FormDialog>
  );
}

function ChangeLimit({ row }: { row: LimitRow }) {
  const refresh = useRefresh();
  const [value, setValue] = useState(String(row.value));
  const number = Number(value);
  return (
    <FormDialog label="Изменить" title="Изменить лимит" variant="outline" size="sm">
      <DialogForm
        submitLabel="Сохранить"
        canSubmit={Number.isInteger(number) && number >= 1 && number !== row.value}
        onSubmit={async () => {
          await request<unknown>(`/partner/limits/${row.id}`, {
            method: 'PATCH',
            body: { value: number },
          });
          await refresh();
        }}
      >
        <DialogField
          label={row.metric === 'calls' ? 'Звонков, не больше' : 'Минут, не больше'}
          hint="Израсходованное не обнуляется"
        >
          <Input
            required
            autoFocus
            type="number"
            className="num"
            min={1}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </DialogField>
      </DialogForm>
    </FormDialog>
  );
}

function RemoveLimit({ row }: { row: LimitRow }) {
  const refresh = useRefresh();
  return (
    <ConfirmAction
      label="Удалить"
      title="Удалить лимит"
      consequence={
        <p>
          Лимит {counted(row.metric, row.value)} {LIMIT_WINDOW_NAME[row.window]} перестанет
          действовать, израсходованное по нему обнулится.
        </p>
      }
      confirmLabel="Удалить лимит"
      onConfirm={async () => {
        await request<unknown>(`/partner/limits/${row.id}`, { method: 'DELETE' });
        await refresh();
      }}
    />
  );
}
