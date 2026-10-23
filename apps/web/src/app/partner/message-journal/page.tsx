'use client';

import { useQuery } from '@tanstack/react-query';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import {
  JournalFilters,
  JournalPages,
  journalSearch,
  useJournalFilter,
} from '@/components/message-journal';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, request } from '@/lib/api';
import { loadAllRows } from '@/lib/csv';
import { moment } from '@/lib/format';
import { MESSAGE_FAILURE_NAME, MESSAGE_STATUS_NAME, messageTone } from '@/lib/labels';
import { money } from '@/lib/money';

interface PartnerMessage {
  readonly id: string;
  readonly account_id: string | null;
  readonly status: string;
  readonly failure_reason: string | null;
  readonly earned: string;
  readonly created_at: string;
}

const PATH = '/partner/messages/journal';

export default function PartnerMessageJournalPage() {
  return (
    <ConsoleShell title="Сообщения MAX" cabinet="partner">
      {() => <Journal />}
    </ConsoleShell>
  );
}

/**
 * Журнал сообщений через аккаунты партнёра и начисленного за них — как «Вызовы» у звонков (владелец, 2026-10-23). Без
 * получателя, текста и клиента: это чужие данные (ADR-0014).
 */
function Journal() {
  const [filter, changeFilter] = useJournalFilter();
  const search = journalSearch(filter);
  const list = useQuery({
    queryKey: ['partner', 'message-journal', search.toString()],
    queryFn: ({ signal }) =>
      request<{ messages: PartnerMessage[]; total: number }>(`${PATH}?${search.toString()}`, {
        signal,
      }),
    refetchInterval: 15_000,
  });
  const accounts = useQuery({
    queryKey: ['partner', 'messenger', 'accounts', 'names'],
    queryFn: ({ signal }) =>
      request<{ accounts: { id: string; label: string }[] }>('/partner/messenger/accounts', {
        signal,
      }),
    staleTime: 60_000,
  });
  const accountName = (id: string | null): string =>
    id === null ? '—' : (accounts.data?.accounts.find((row) => row.id === id)?.label ?? '—');
  const error = list.error instanceof ApiError ? list.error : undefined;

  return (
    <div className="flex flex-col gap-3">
      <JournalFilters
        filter={filter}
        onChange={changeFilter}
        exportName="сообщения-max"
        load={async () => {
          const filters = journalSearch(filter);
          filters.delete('offset');
          const found = await loadAllRows<PartnerMessage>(PATH, filters, 'messages');
          return {
            header: ['Когда', 'Аккаунт', 'Итог', 'Начислено, ₽'],
            rows: found.rows.map((message) => [
              moment(message.created_at),
              accountName(message.account_id),
              MESSAGE_STATUS_NAME[message.status] ?? message.status,
              message.earned,
            ]),
            truncated: found.truncated,
          };
        }}
      />
      {error !== undefined && <ErrorNote error={error} />}
      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Когда</TableHead>
              <TableHead className="h-8">Аккаунт</TableHead>
              <TableHead className="h-8">Итог</TableHead>
              <TableHead className="h-8 text-right">Начислено</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}
            {list.data?.messages.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="text-muted-foreground">
                  По этому отбору сообщений нет.
                </TableCell>
              </TableRow>
            )}
            {list.data?.messages.map((message) => (
              <TableRow key={message.id}>
                <TableCell>
                  <span className="num text-muted-foreground">{moment(message.created_at)}</span>
                </TableCell>
                <TableCell>{accountName(message.account_id)}</TableCell>
                <TableCell className="whitespace-normal">
                  <span className={`rounded-md px-2 py-0.5 ${messageTone(message.status)}`}>
                    {MESSAGE_STATUS_NAME[message.status] ?? message.status}
                  </span>
                  {message.failure_reason !== null && (
                    <span className="block pt-0.5 text-muted-foreground">
                      {MESSAGE_FAILURE_NAME[message.failure_reason] ?? message.failure_reason}
                    </span>
                  )}
                </TableCell>
                <TableCell className="num text-right">{money(message.earned)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <JournalPages filter={filter} total={list.data?.total} onChange={changeFilter} />
    </div>
  );
}
