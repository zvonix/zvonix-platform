'use client';

import { useQuery } from '@tanstack/react-query';
import { CLIENT_STATUSES, type ClientStatus } from '@zvonix/shared';
import Link from 'next/link';
import { Suspense } from 'react';
import { Choice } from '@/components/choice';
import { ConsoleShell } from '@/components/console-shell';
import { FilterInput } from '@/components/filter-input';
import { PageNav } from '@/components/page-nav';
import { SavedFilters, useColumnPicker } from '@/components/table-view';
import { Button } from '@/components/ui/button';
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
import { CLIENT_STATUS_NAME, clientStatusTone } from '@/lib/labels';
import { isNegative, money } from '@/lib/money';
import { useUrlState } from '@/lib/url-state';
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

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

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

/**
 * Список клиентов. Всё, что делается с одним клиентом, — на его карточке `/clients/<id>`
 * ([DESIGN.md](../../../../../docs/DESIGN.md), «Окно, страница или панель»): раньше
 * деньги и каналы раскрывались строкой таблицы и сдвигали список.
 */
function ClientsTable() {
  const canChange = useCanChange();
  const url = useUrlState();
  const columns = useColumnPicker('clients');

  const offset = Number.parseInt(url.get('offset'), 10) || 0;
  const search = new URLSearchParams(url.query);
  search.set('limit', String(PAGE_SIZE));

  const list = useQuery({
    queryKey: ['clients', search.toString()],
    queryFn: () =>
      request<{ clients: ClientRow[]; total: number }>(`/clients?${search.toString()}`),
  });

  const listError = asApiError(list.error);

  // Ключ и форма ответа те же, что на странице наценок: общий ключ — общая форма данных.
  const rules = useQuery({
    queryKey: ['commission-rules'],
    queryFn: () => request<{ rules: { id: string }[] }>('/commission-rules'),
  });

  return (
    <div className="flex flex-col gap-3">
      {rules.data?.rules.length === 0 && (
        <p role="alert" className="text-warn">
          Наценки нет ни у кого: вызовы клиентов отклоняются («нет тарифа»). Задайте правило «для
          всех клиентов» в разделе «Тарифы и наценка».
        </p>
      )}

      {canChange ? (
        <div>
          <NewClientForm />
        </div>
      ) : (
        <ReadOnly what="клиентов, их каналы и деньги" />
      )}

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

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SavedFilters />
          {columns.picker}
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

      {listError !== undefined && <ErrorNote error={listError} />}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table {...columns.tableProps}>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Название</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8 text-right">Остаток</TableHead>
              <TableHead className="h-8 text-right">Разрешённый минус</TableHead>
              <TableHead className="h-8">Добавлен</TableHead>
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
              <TableRow key={client.id}>
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
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`/clients/${client.id}`}
                      aria-label={`Открыть клиента «${client.name}»`}
                    >
                      Открыть
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
