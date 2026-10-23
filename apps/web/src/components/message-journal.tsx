'use client';

import { MESSAGE_STATUSES } from '@zvonix/shared';
import { useState } from 'react';
import { ExportButton, type ExportTable } from '@/components/export-button';
import { PageNav } from '@/components/page-nav';
import { PeriodInput } from '@/components/period-input';
import { MESSAGE_STATUS_NAME } from '@/lib/labels';

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
