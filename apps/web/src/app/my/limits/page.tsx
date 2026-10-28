'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LIMIT_METRICS, LIMIT_WINDOWS, type LimitMetric, type LimitWindow } from '@zvonix/shared';
import Link from 'next/link';
import { useState } from 'react';
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
import { momentInZone } from '@/lib/format';
import { LIMIT_WINDOW_NAME, limitRuleNote } from '@/lib/labels';
import {
  amount,
  ChangeLimit,
  counted,
  limitValueLabel,
  RemoveLimit,
  type LimitRow,
  type LimitsScope,
} from '@/lib/limits';
import { integerFromInput } from '@/lib/money';
import { timezoneLabel } from '@/lib/timezones';
import { useChannels } from '../channels/channels';

const SCOPE: LimitsScope = { path: '/client/limits', key: ['my', 'limits'] };
const COLUMNS = 6;
const SELECT_CLASS = 'h-9 w-full rounded-md border border-input bg-transparent px-2';

const METRIC_CHOICE: Record<LimitMetric, string> = {
  calls: 'Звонки',
  minutes: 'Минуты разговора',
  money: 'Деньги',
};

/** Верхняя граница предела — та же, что проверяет API. */
const VALUE_MAX = 10_000_000;

export default function MyLimitsPage() {
  return (
    <ConsoleShell title="Лимиты" cabinet="client">
      {() => <MyLimits />}
    </ConsoleShell>
  );
}

/**
 * Лимиты клиента на себя и свои линии ([ADR-0102](../../../../../../docs/adr/0102-chasovoy-poyas-akkaunta-i-limity.md)):
 * звонки, минуты или деньги за окно. Защита от зациклившейся программы и украденного пароля линии. Сутки — в поясе
 * аккаунта.
 */
function MyLimits() {
  const limits = useQuery({
    queryKey: [...SCOPE.key],
    queryFn: () => request<{ limits: LimitRow[]; timezone: string | null }>('/client/limits'),
  });
  const channels = useChannels();
  const lineName = (id: string | null): string =>
    id === null
      ? 'Все линии'
      : (channels.data?.channels.find((channel) => channel.id === id)?.name ?? '—');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <NewLimit lines={channels.data?.channels ?? []} />
        {limits.data !== undefined && (
          <span className="text-muted-foreground">
            Сутки —{' '}
            {limits.data.timezone === null
              ? 'с 03:00 по Москве'
              : `с 00:00 · ${timezoneLabel(limits.data.timezone)}`}
            .{' '}
            <Link href="/my/account" className="text-primary underline-offset-4 hover:underline">
              Часовой пояс
            </Link>
          </span>
        )}
      </div>

      {limits.error !== null && (
        <p role="alert" className="text-crit">
          {limits.error.message}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Лимит</TableHead>
              <TableHead className="h-8">На что</TableHead>
              <TableHead className="hidden h-8 text-right sm:table-cell">Израсходовано</TableHead>
              <TableHead className="h-8 text-right">Осталось</TableHead>
              <TableHead className="h-8">Обнулится</TableHead>
              <TableHead className="h-8">
                <span className="sr-only">Действия</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {limits.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}
            {limits.data?.limits.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="whitespace-normal text-muted-foreground">
                  Лимитов нет.
                </TableCell>
              </TableRow>
            )}
            {limits.data?.limits.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-normal">
                  {counted(row.metric, row.value)} {LIMIT_WINDOW_NAME[row.window]}
                  <span className="block text-faint">{limitRuleNote(row)}</span>
                </TableCell>
                <TableCell>{lineName(row.channel_id)}</TableCell>
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
                  {momentInZone(row.resets_at, row.timezone)}
                </TableCell>
                <TableCell>
                  {row.set_by === 'client' ? (
                    <div className="flex flex-wrap justify-end gap-2">
                      <ChangeLimit row={row} scope={SCOPE} />
                      <RemoveLimit row={row} scope={SCOPE} />
                    </div>
                  ) : (
                    <span className="text-muted-foreground">задала площадка</span>
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

/** Новый лимит: на все линии или одну, звонки, минуты или деньги за окно. */
function NewLimit({ lines }: { lines: readonly { id: string; name: string }[] }) {
  const queryClient = useQueryClient();
  const [line, setLine] = useState('');
  const [metric, setMetric] = useState<LimitMetric>('money');
  const [span, setSpan] = useState<LimitWindow>('day');
  const [value, setValue] = useState('');
  const number = integerFromInput(value);
  const valid = number !== undefined && number >= 1 && number <= VALUE_MAX;

  return (
    <FormDialog label="Добавить лимит" title="Новый лимит" variant="outline">
      <DialogForm
        submitLabel="Добавить лимит"
        canSubmit={valid}
        onSubmit={async () => {
          await request('/client/limits', {
            method: 'POST',
            body: {
              ...(line === '' ? { scope: 'client' } : { scope: 'channel', channelId: line }),
              metric,
              window: span,
              value: number,
            },
          });
          setValue('');
          await queryClient.invalidateQueries({ queryKey: [...SCOPE.key] });
        }}
      >
        <DialogField label="На что" wide>
          <select
            value={line}
            onChange={(event) => {
              setLine(event.target.value);
            }}
            className={SELECT_CLASS}
          >
            <option value="">Все линии вместе</option>
            {lines.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </DialogField>
        <DialogField label="Что считать">
          <select
            value={metric}
            onChange={(event) => {
              setMetric(event.target.value as LimitMetric);
            }}
            className={SELECT_CLASS}
          >
            {LIMIT_METRICS.map((item) => (
              <option key={item} value={item}>
                {METRIC_CHOICE[item]}
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
            className={SELECT_CLASS}
          >
            {LIMIT_WINDOWS.map((item) => (
              <option key={item} value={item}>
                {LIMIT_WINDOW_NAME[item]}
              </option>
            ))}
          </select>
        </DialogField>
        <DialogField label={limitValueLabel(metric)}>
          <Input
            required
            inputMode="numeric"
            className="num"
            autoComplete="off"
            value={value}
            aria-invalid={value !== '' && !valid}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </DialogField>
      </DialogForm>
    </FormDialog>
  );
}
