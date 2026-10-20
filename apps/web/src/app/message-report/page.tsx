'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, request } from '@/lib/api';
import { MESSAGE_FAILURE_NAME } from '@/lib/labels';

interface Counts {
  readonly total: number;
  readonly sent: number;
  readonly delivered: number;
  readonly read: number;
  readonly failed: number;
  readonly not_in_max: number;
  readonly account_unavailable: number;
  readonly wait_expired: number;
  readonly platform: number;
  readonly recipient_stopped: number;
  readonly settled: number;
  readonly settled_read: number;
}

interface ClientRow extends Counts {
  readonly client_id: string;
  readonly name: string;
}

interface AccountRow extends Counts {
  readonly account_id: string;
  readonly label: string;
  readonly partner_name: string;
  readonly status: string;
  readonly state_reason: string | null;
  readonly paused_until: string | null;
  readonly pause_reason: string | null;
}

interface Report {
  readonly days: number;
  readonly clients: ClientRow[];
  readonly accounts: AccountRow[];
}

const PERIODS = [7, 14, 30] as const;

/** Меньше этого ушедших — доля читавших ничего не говорит: показываем «—». */
const MIN_SETTLED = 20;
/** Доля непрочитанных и отказов «нет MAX», с которой число подсвечивается. */
const UNREAD_WARN = 70;
const ABSENT_WARN = 30;

const percent = (part: number, whole: number): number | undefined =>
  whole === 0 ? undefined : Math.round((part * 100) / whole);

export default function MessagingReportPage() {
  return (
    <ConsoleShell title="Отчёты MAX" requireRole={['admin', 'support']}>
      {() => <ReportView />}
    </ConsoleShell>
  );
}

function ReportView() {
  const [days, setDays] = useState<number>(7);
  const report = useQuery({
    queryKey: ['messenger', 'report', days],
    queryFn: ({ signal }) => request<Report>(`/messages/report?days=${String(days)}`, { signal }),
    refetchInterval: 60_000,
  });
  const error = report.error instanceof ApiError ? report.error : undefined;

  return (
    <div className="flex max-w-[1200px] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Период">
        {PERIODS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={days === value}
            onClick={() => {
              setDays(value);
            }}
            className={`rounded-md border px-3 py-1 ${days === value ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card'}`}
          >
            {value} дн.
          </button>
        ))}
        <Hint label="Как читать отчёт">
          <p>
            «Не прочитано» считается только у сообщений через аккаунты партнёров, ушедших больше
            суток назад: у бота статуса «прочитано» нет. Мало сообщений — прочерк.
          </p>
        </Hint>
      </div>

      {error !== undefined && <ErrorNote error={error} />}
      {report.isPending && <p className="text-muted-foreground">Загружаем…</p>}

      {report.data !== undefined && (
        <>
          <h2 className="font-semibold">По клиентам</h2>
          <Section
            what="Клиент"
            rows={report.data.clients.map((row) => ({
              key: row.client_id,
              title: row.name,
              row,
            }))}
          />
          <h2 className="font-semibold">По аккаунтам</h2>
          <Section
            what="Аккаунт"
            rows={report.data.accounts.map((row) => ({
              key: row.account_id,
              title: `${row.label} · ${row.partner_name}`,
              note: accountNote(row),
              row,
            }))}
          />
        </>
      )}
    </div>
  );
}

function accountNote(row: AccountRow): string | undefined {
  if (row.status === 'blocked' || row.state_reason === 'blocked') return 'заблокирован MAX';
  if (row.status !== 'active') return 'не работает';
  if (row.paused_until !== null && Date.parse(row.paused_until) > Date.now()) return 'на паузе';
  return undefined;
}

function Section({
  rows,
  what,
}: {
  rows: { key: string; title: string; note?: string | undefined; row: Counts }[];
  what: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="text-muted-foreground hover:bg-transparent">
            <TableHead className="h-8">{what}</TableHead>
            <TableHead className="h-8 text-right">Принято</TableHead>
            <TableHead className="h-8 text-right">Доставлено</TableHead>
            <TableHead className="h-8 text-right">Не отправлено</TableHead>
            <TableHead className="h-8">Причины отказов</TableHead>
            <TableHead className="h-8 text-right">Не прочитано</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={6} className="text-muted-foreground">
                За период сообщений нет.
              </TableCell>
            </TableRow>
          )}
          {rows.map(({ key, title, note, row }) => {
            const unread =
              row.settled < MIN_SETTLED
                ? undefined
                : percent(row.settled - row.settled_read, row.settled);
            const absent = percent(row.not_in_max, row.total);
            const absentHigh =
              absent !== undefined && absent >= ABSENT_WARN && row.total >= MIN_SETTLED;
            return (
              <TableRow key={key}>
                <TableCell className="whitespace-normal">
                  {title}
                  {note !== undefined && <span className="ml-2 text-crit">{note}</span>}
                </TableCell>
                <TableCell className="num text-right">{row.total}</TableCell>
                <TableCell className="num text-right">{row.delivered}</TableCell>
                <TableCell className={`num text-right ${absentHigh ? 'text-warn' : ''}`}>
                  {row.failed}
                </TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">
                  {reasons(row)}
                </TableCell>
                <TableCell
                  className={`num text-right ${unread !== undefined && unread >= UNREAD_WARN ? 'text-warn' : ''}`}
                >
                  {unread === undefined ? '—' : `${String(unread)} %`}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function reasons(row: Counts): string {
  const parts: [string, number][] = [
    [MESSAGE_FAILURE_NAME['recipient_not_in_max'] ?? '', row.not_in_max],
    [MESSAGE_FAILURE_NAME['account_unavailable'] ?? '', row.account_unavailable],
    [MESSAGE_FAILURE_NAME['wait_expired'] ?? '', row.wait_expired],
    [MESSAGE_FAILURE_NAME['recipient_stopped'] ?? '', row.recipient_stopped],
    [MESSAGE_FAILURE_NAME['platform'] ?? '', row.platform],
  ];
  const shown = parts
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}: ${String(count)}`);
  return shown.length === 0 ? '—' : shown.join('; ');
}
