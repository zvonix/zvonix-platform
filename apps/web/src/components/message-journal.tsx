'use client';

import { MESSAGE_STATUSES } from '@zvonix/shared';
import { useState } from 'react';
import { ExportButton, type ExportTable } from '@/components/export-button';
import { PageNav } from '@/components/page-nav';
import { PeriodInput } from '@/components/period-input';
import { TableCell, TableHead } from '@/components/ui/table';
import { moment } from '@/lib/format';
import { MESSAGE_FAILURE_NAME, MESSAGE_STATUS_NAME, messageTone } from '@/lib/labels';

/** Строк журнала на страницу. */
const JOURNAL_PAGE = 50;

export interface JournalFilter {
  readonly status: string;
  readonly from: string;
  readonly to: string;
  readonly offset: number;
}

/**
 * Отбор журнала сообщений — общий у клиента, партнёра и сотрудников: итог, период, страница. Журнал отдавал последние 50 без
 * отбора и выгрузки, у вызовов всё это было (владелец, 2026-10-23).
 */
export function useJournalFilter() {
  const [filter, setFilter] = useState<JournalFilter>({ status: '', from: '', to: '', offset: 0 });
  /** Смена отбора возвращает на первую страницу; смена страницы — только страницу. */
  const change = (next: Partial<JournalFilter>): void => {
    setFilter((current) => ({ ...current, offset: 0, ...next }));
  };
  return [filter, change] as const;
}

/** Параметры запроса под отбор; `extra` — свои отборы страницы (клиент, партнёр). */
export function journalSearch(
  filter: JournalFilter,
  extra: Readonly<Record<string, string>> = {},
): URLSearchParams {
  const search = new URLSearchParams({
    limit: String(JOURNAL_PAGE),
    offset: String(filter.offset),
  });
  if (filter.status !== '') search.set('status', filter.status);
  if (filter.from !== '') search.set('from', filter.from);
  if (filter.to !== '') search.set('to', filter.to);
  for (const [key, value] of Object.entries(extra)) if (value !== '') search.set(key, value);
  return search;
}

export function JournalFilters({
  filter,
  onChange,
  exportName,
  load,
  children,
}: {
  filter: JournalFilter;
  onChange: (next: Partial<JournalFilter>) => void;
  exportName: string;
  load: () => Promise<ExportTable>;
  /** Свои отборы страницы — перед периодом. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      {children}
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Итог</span>
        <select
          value={filter.status}
          onChange={(event) => {
            onChange({ status: event.target.value });
          }}
          className="h-9 w-[150px] rounded-md border border-input bg-transparent px-2"
        >
          <option value="">любой</option>
          {MESSAGE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {MESSAGE_STATUS_NAME[status] ?? status}
            </option>
          ))}
        </select>
      </label>
      <PeriodInput
        label="С"
        value={filter.from}
        onChange={(from) => {
          onChange({ from });
        }}
      />
      <PeriodInput
        label="По"
        value={filter.to}
        onChange={(to) => {
          onChange({ to });
        }}
      />
      <div className="ml-auto">
        <ExportButton name={exportName} load={load} />
      </div>
    </div>
  );
}

export function JournalPages({
  filter,
  total,
  onChange,
}: {
  filter: JournalFilter;
  total: number | undefined;
  onChange: (next: Partial<JournalFilter>) => void;
}) {
  if (total === undefined || total <= JOURNAL_PAGE) return null;
  return (
    <PageNav
      offset={filter.offset}
      limit={JOURNAL_PAGE}
      total={total}
      onChange={(offset) => {
        onChange({ offset });
      }}
    />
  );
}

/** Моменты сообщения по этапам — как их отдаёт API у клиента, партнёра и сотрудников. */
export interface MessageStages {
  readonly status: string;
  readonly failure_reason: string | null;
  readonly created_at: string;
  readonly sent_at: string | null;
  readonly delivered_at: string | null;
  readonly read_at: string | null;
}

const SHORT_TIME = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const SHORT_DAY = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });

/** Время этапа коротко: в день приёма — только часы, иначе ещё и число («24.10 08:12:05»). */
function stageTime(at: Date, accepted: Date): string {
  const time = SHORT_TIME.format(at);
  return at.toDateString() === accepted.toDateString() ? time : `${SHORT_DAY.format(at)} ${time}`;
}

/** Сколько прошло от предыдущего этапа: «+6 с», «+2 мин 5 с», «+1 ч 3 мин». */
function delay(from: Date, to: Date): string {
  const seconds = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (seconds < 60) return `+${String(seconds)} с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `+${String(minutes)} мин ${String(seconds % 60)} с`;
  return `+${String(Math.floor(minutes / 60))} ч ${String(minutes % 60)} мин`;
}

/** Заголовки трёх столбцов этапов — рядом с «Принято» у всех журналов. */
export function StageHeads() {
  return (
    <>
      <TableHead className="h-8">Ушло</TableHead>
      <TableHead className="h-8">Доставлено</TableHead>
      <TableHead className="h-8">Прочитано</TableHead>
    </>
  );
}

/**
 * Ячейки «Ушло · Доставлено · Прочитано» вместо одного «Итога» (владелец, 2026-10-23: «видеть, когда отправлено, доставлено и
 * прочитано»). Состояние читается по тому, до какого столбца дошло время; полная дата и задержка от прошлого этапа — в подсказке.
 * Не отправлено — одна строка на три столбца с причиной; ещё не ушло — «в очереди» или «отправляется» в первом.
 */
export function StageCells({
  message,
  refundNote = false,
}: {
  readonly message: MessageStages;
  /** Дописать «деньги возвращены» к причине отказа — клиенту. */
  readonly refundNote?: boolean;
}) {
  if (message.status === 'failed') {
    return (
      <TableCell colSpan={3} className="whitespace-normal">
        <span className={`rounded-md px-2 py-0.5 ${messageTone('failed')}`}>
          {MESSAGE_STATUS_NAME['failed'] ?? 'Не отправлено'}
        </span>
        {message.failure_reason !== null && (
          <span className="pl-2 text-muted-foreground">
            {MESSAGE_FAILURE_NAME[message.failure_reason] ?? message.failure_reason}
            {refundNote && '; деньги возвращены'}
          </span>
        )}
      </TableCell>
    );
  }
  const accepted = new Date(message.created_at);
  const stages = [
    { at: message.sent_at, after: 'принято', previous: message.created_at },
    { at: message.delivered_at, after: 'ушло', previous: message.sent_at },
    { at: message.read_at, after: 'доставлено', previous: message.delivered_at ?? message.sent_at },
  ];
  return (
    <>
      {stages.map((stage, index) => {
        if (stage.at === null) {
          // Ещё не ушло — что с ним сейчас, в первом столбце; дальше прочерк.
          const waiting =
            index === 0 && (message.status === 'queued' || message.status === 'sending');
          return (
            <TableCell key={stage.after}>
              {waiting ? (
                <span className={`rounded-md px-2 py-0.5 ${messageTone(message.status)}`}>
                  {MESSAGE_STATUS_NAME[message.status] ?? message.status}
                </span>
              ) : (
                <span className="text-faint">—</span>
              )}
            </TableCell>
          );
        }
        const at = new Date(stage.at);
        const previous = stage.previous === null ? undefined : new Date(stage.previous);
        return (
          <TableCell key={stage.after}>
            <span
              className="num"
              title={`${moment(stage.at)}${previous === undefined ? '' : ` · ${delay(previous, at)} после «${stage.after}»`}`}
            >
              {stageTime(at, accepted)}
            </span>
          </TableCell>
        );
      })}
    </>
  );
}

/** Три времени этапов для выгрузки: полная дата или пусто. */
export function stageColumns(message: MessageStages): string[] {
  return [message.sent_at, message.delivered_at, message.read_at].map((at) =>
    at === null ? '' : moment(at),
  );
}
