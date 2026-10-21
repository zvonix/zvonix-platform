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
import { moment } from '@/lib/format';
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

interface JournalAccount {
  readonly account_id: string;
  readonly label: string;
  readonly partner_name: string;
  readonly status: string;
  readonly checks: { exists: number; absent: number; unknown: number; limited: number };
  readonly blocked: number;
  readonly suspended: number;
  readonly logged_out: number;
  readonly health_paused: number;
}

interface JournalEvent {
  readonly account_id: string;
  readonly label: string;
  readonly kind: 'unavailable' | 'active' | 'health_paused';
  readonly reason: 'suspended' | 'blocked' | 'logged_out' | null;
  readonly at: string;
}

interface Report {
  readonly days: number;
  readonly clients: ClientRow[];
  readonly accounts: AccountRow[];
  readonly journal: {
    readonly sent_via_accounts: number;
    readonly blocked: number;
    readonly accounts: JournalAccount[];
    readonly recent: JournalEvent[];
  };
}

/** Что произошло с аккаунтом: словами для ленты событий. */
function eventName(event: JournalEvent): string {
  if (event.kind === 'active') return 'вернулся в работу';
  if (event.kind === 'health_paused') return 'пауза: много «нет MAX» после отправки';
  if (event.reason === 'blocked') return 'заблокирован MAX';
  if (event.reason === 'suspended') return 'приостановлен у провайдера';
  return 'вышел из MAX';
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
          <Journal journal={report.data.journal} />
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

/** Журнал аккаунтов: сколько блокировок на тысячу сообщений, проверки номеров на MAX и последние события (ADR-0088). */
function Journal({ journal }: { journal: Report['journal'] }) {
  const per1000 =
    journal.sent_via_accounts === 0
      ? undefined
      : Math.round((journal.blocked * 10_000) / journal.sent_via_accounts) / 10;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Журнал аккаунтов</h2>
        <Hint label="Что в журнале">
          <p>
            Блокировки на тысячу сообщений — по ним поднимают или снижают рекомендованные лимиты в
            «Настройках площадки». Проверки номеров — запросы «есть ли у номера MAX» к провайдеру;
            повтор из памяти не считается.
          </p>
        </Hint>
        <span className="num text-muted-foreground">
          Блокировок на 1000 сообщений: {per1000 === undefined ? '—' : String(per1000)} (блокировок{' '}
          {String(journal.blocked)}, сообщений {String(journal.sent_via_accounts)})
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Аккаунт</TableHead>
              <TableHead className="h-8 text-right">Нет MAX</TableHead>
              <TableHead className="h-8 text-right">Есть MAX</TableHead>
              <TableHead className="h-8 text-right">Предел проверок</TableHead>
              <TableHead className="h-8 text-right">Не удалось</TableHead>
              <TableHead className="h-8 text-right">Блокировок</TableHead>
              <TableHead className="h-8 text-right">Пауз</TableHead>
              <TableHead className="h-8 text-right">Выходов</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {journal.accounts.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="text-muted-foreground">
                  За период записей нет.
                </TableCell>
              </TableRow>
            )}
            {journal.accounts.map((row) => (
              <TableRow key={row.account_id}>
                <TableCell className="whitespace-normal">{`${row.label} · ${row.partner_name}`}</TableCell>
                <TableCell className="num text-right">{row.checks.absent}</TableCell>
                <TableCell className="num text-right">{row.checks.exists}</TableCell>
                <TableCell
                  className={`num text-right ${row.checks.limited > 0 ? 'text-warn' : ''}`}
                >
                  {row.checks.limited}
                </TableCell>
                <TableCell className="num text-right">{row.checks.unknown}</TableCell>
                <TableCell className={`num text-right ${row.blocked > 0 ? 'text-crit' : ''}`}>
                  {row.blocked}
                </TableCell>
                <TableCell className="num text-right">{row.health_paused}</TableCell>
                <TableCell className="num text-right">{row.logged_out + row.suspended}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {journal.recent.length > 0 && (
        <ul className="flex flex-col gap-1">
          {journal.recent.map((event) => (
            <li
              key={`${event.account_id}-${event.at}-${event.kind}`}
              className="flex flex-wrap gap-x-3"
            >
              <span className="num text-muted-foreground">{moment(event.at)}</span>
              <span>{event.label}</span>
              <span className="text-muted-foreground">{eventName(event)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
