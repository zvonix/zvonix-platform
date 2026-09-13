'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLIENT_STATUSES, type ClientStatus } from '@zvonix/shared';
import { Suspense, useState } from 'react';
import { AccountLedger } from '@/components/account-ledger';
import { Choice } from '@/components/choice';
import { ConsoleShell } from '@/components/console-shell';
import { FilterInput } from '@/components/filter-input';
import { PageNav } from '@/components/page-nav';
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
import { ReadOnly } from '@/components/read-only';
import { useCanChange } from '@/lib/access';
import { ErrorNote } from '@/components/error-note';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { CLIENT_STATUS_MEANING, CLIENT_STATUS_NAME, clientStatusTone } from '@/lib/labels';
import { isNegative, money, numberFromInput } from '@/lib/money';
import { useUrlState } from '@/lib/url-state';
import { ClientChannels } from './client-channels';
import { DepositForm } from './deposit-form';
import { NewClientForm } from './new-client-form';

const PAGE_SIZE = 50;
const COLUMNS = 6;

export interface ClientRow {
  readonly id: string;
  readonly name: string;
  readonly status: ClientStatus;
  readonly overdraft_limit: string;
  readonly balance: string;
  readonly created_at: string;
}

export default function ClientsPage() {
  return (
    <ConsoleShell title="Клиенты и деньги" requireRole={['admin', 'support']}>
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <ClientsTable />
        </Suspense>
      )}
    </ConsoleShell>
  );
}

function ClientsTable() {
  const canChange = useCanChange();
  const url = useUrlState();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState<string | undefined>(undefined);

  const offset = Number.parseInt(url.get('offset'), 10) || 0;
  const search = new URLSearchParams(url.query);
  search.set('limit', String(PAGE_SIZE));

  const list = useQuery({
    queryKey: ['clients', search.toString()],
    queryFn: () =>
      request<{ clients: ClientRow[]; total: number }>(`/clients?${search.toString()}`),
  });

  const change = useMutation({
    mutationFn: (input: { id: string; status: ClientStatus }) =>
      request<unknown>(`/clients/${input.id}/status`, {
        method: 'PATCH',
        body: { status: input.status },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });

  const overdraft = useMutation({
    mutationFn: (input: { id: string; value: string }) =>
      request<unknown>(`/clients/${input.id}/overdraft`, {
        method: 'PATCH',
        body: { overdraftLimit: numberFromInput(input.value) },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });

  const changeError = [change.error, overdraft.error].find(
    (error): error is ApiError => error instanceof ApiError,
  );

  return (
    <div className="flex flex-col gap-3">
      {canChange ? <NewClientForm /> : <ReadOnly what="клиентов, их каналы и деньги" />}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Название</span>
          <FilterInput
            className="w-[220px]"
            placeholder="часть названия"
            value={url.get('name')}
            onChange={(name) => {
              url.set({ name, offset: '' });
            }}
          />
        </label>

        <Choice
          label="Состояние"
          anyLabel="любое"
          value={url.get('status')}
          options={CLIENT_STATUSES.map((status) => [status, CLIENT_STATUS_NAME[status]])}
          onChange={(value) => {
            url.set({ status: value, offset: '' });
          }}
        />

        <div className="ml-auto">
          <PageNav
            offset={offset}
            limit={PAGE_SIZE}
            total={list.data?.total ?? 0}
            onChange={(next) => {
              url.set({ offset: next === 0 ? '' : String(next) });
            }}
          />
        </div>
      </div>

      {changeError !== undefined && <ErrorNote error={changeError} />}

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Название</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8 text-right">Остаток</TableHead>
              <TableHead className="h-8 text-right">Разрешённый минус</TableHead>
              <TableHead className="h-8">Заведён</TableHead>
              <TableHead className="h-8"> </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {list.data?.clients.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  По этому отбору клиентов нет.
                </TableCell>
              </TableRow>
            )}

            {list.data?.clients.map((client) => (
              <ClientRows
                key={client.id}
                client={client}
                open={opened === client.id}
                busy={change.isPending}
                onToggle={() => {
                  setOpened(opened === client.id ? undefined : client.id);
                }}
                onChoose={(status) => {
                  change.mutate({ id: client.id, status });
                }}
                onOverdraft={(value) => {
                  overdraft.mutate({ id: client.id, value });
                }}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ClientRows({
  client,
  open,
  busy,
  onToggle,
  onChoose,
  onOverdraft,
}: {
  client: ClientRow;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onChoose: (status: ClientStatus) => void;
  onOverdraft: (value: string) => void;
}) {
  const canChange = useCanChange();
  return (
    <>
      <TableRow>
        <TableCell>{client.name}</TableCell>
        <TableCell>
          <span className={`rounded-sm px-1.5 py-0.5 ${clientStatusTone(client.status)}`}>
            {CLIENT_STATUS_NAME[client.status]}
          </span>
        </TableCell>
        <TableCell className="num text-right">
          {/*
            Отрицательный остаток выделяется, но не паникой: при разрешённом минусе
            это штатное состояние, а не авария (DESIGN.md).
          */}
          <span className={isNegative(client.balance) ? 'text-warn' : undefined}>
            {money(client.balance)}
          </span>
        </TableCell>
        <TableCell className="num text-right text-muted-foreground">
          {money(client.overdraft_limit)}
        </TableCell>
        <TableCell>
          <span className="num text-muted-foreground">{moment(client.created_at)}</span>
        </TableCell>
        <TableCell>
          <Button variant="outline" size="sm" onClick={onToggle} aria-expanded={open}>
            {open ? 'Свернуть' : 'Деньги'}
          </Button>
        </TableCell>
      </TableRow>

      {open && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={COLUMNS} className="whitespace-normal">
            <div className="flex flex-col gap-4">
              {canChange && (
                <>
                  <StatusChoice client={client} busy={busy} onChoose={onChoose} />
                  <OverdraftField client={client} busy={busy} onChange={onOverdraft} />
                </>
              )}
              <ClientChannels clientId={client.id} />
              {canChange && <DepositForm client={client} />}
              <AccountLedger source={`/clients/${client.id}/entries`} />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * Смена состояния клиента.
 *
 * Последствие названо у каждого варианта ([DESIGN.md](../../../../../docs/DESIGN.md)),
 * и оно не косметическое: маршрутизация требует `active` **и от канала, и от клиента**,
 * поэтому любое другое состояние означает «ни один канал не звонит». Из `closed`
 * вариантов нет вовсе: переход необратим, и предлагать его обратно — обещать то,
 * чего API не сделает.
 */
function StatusChoice({
  client,
  busy,
  onChoose,
}: {
  client: ClientRow;
  busy: boolean;
  onChoose: (status: ClientStatus) => void;
}) {
  if (client.status === 'closed') {
    return (
      <p className="text-muted-foreground">
        Клиент закрыт. Это состояние окончательное — вернуть его в работу нельзя, нужен новый
        клиент.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold">Состояние</h3>
      <p className="text-muted-foreground">
        Сейчас — {CLIENT_STATUS_NAME[client.status].toLowerCase()}. Смена попадает в журнал вместе с
        тем, что было до.
      </p>
      <div className="flex flex-wrap gap-2">
        {CLIENT_STATUSES.filter((status) => status !== client.status).map((status) => (
          <button
            key={status}
            type="button"
            disabled={busy}
            onClick={() => {
              onChoose(status);
            }}
            className="max-w-[300px] rounded-md border border-border bg-card p-2 text-left hover:border-ring disabled:opacity-50"
          >
            <span className="font-medium">{CLIENT_STATUS_NAME[status]}</span>
            <span className="block text-muted-foreground">{CLIENT_STATUS_MEANING[status]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Разрешённый минус.
 *
 * До появления обработчика задавался только при заведении и потом не менялся ничем:
 * опечатка в разрядах означала кредит, который нечем отозвать. Правка денежная,
 * поэтому попадает в журнал вместе с прежним значением.
 *
 * Отправляется по потере фокуса, а не по каждому нажатию: это деньги, и запрос
 * на символ означал бы полтора десятка записей в журнале на одну правку.
 */
function OverdraftField({
  client,
  busy,
  onChange,
}: {
  client: ClientRow;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-semibold">Разрешённый минус</h3>
      <div className="flex items-center gap-2">
        <Input
          className="num w-[140px]"
          defaultValue={client.overdraft_limit}
          disabled={busy}
          aria-label="Разрешённый минус"
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (value !== '' && value !== client.overdraft_limit) onChange(value);
          }}
        />
        <span className="text-muted-foreground">
          насколько глубоко клиенту разрешено уходить в минус. Ноль — только на свои. Уменьшение
          ниже текущего долга допустимо: это «больше в долг не даём», потраченное при этом никуда не
          девается.
        </span>
      </div>
    </div>
  );
}
