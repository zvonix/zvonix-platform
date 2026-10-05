'use client';

import { useQuery } from '@tanstack/react-query';
import type { UserRole } from '@zvonix/shared';
import { Suspense, useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { FilterInput } from '@/components/filter-input';
import { PageNav } from '@/components/page-nav';
import { PeriodInput } from '@/components/period-input';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';
import { moment } from '@/lib/format';
import { ROLE_NAME } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';

const PAGE_SIZE = 50;
const COLUMNS = 5;

interface AuditEntry {
  readonly id: string;
  readonly occurred_at: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly actor: { id: string; email: string; full_name: string } | null;
  readonly actor_role: UserRole | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly ip: string | null;
  readonly correlation_id: string | null;
}

export default function AuditPage() {
  return (
    <ConsoleShell title="Журнал действий" requireRole={['admin', 'support']}>
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <AuditTable />
        </Suspense>
      )}
    </ConsoleShell>
  );
}

function AuditTable() {
  const url = useUrlState();
  const [opened, setOpened] = useState<string | undefined>(undefined);

  const offset = Number.parseInt(url.get('offset'), 10) || 0;
  const search = new URLSearchParams(url.query);
  search.set('limit', String(PAGE_SIZE));

  const list = useQuery({
    queryKey: ['audit', search.toString()],
    queryFn: () => request<{ entries: AuditEntry[]; total: number }>(`/audit?${search.toString()}`),
  });

  /**
   * Список действий спрашивается у журнала, а не перечисляется здесь: имя действия
   * задаёт код платформы, закрытого списка у него нет, и всякий список в кабинете
   * разошёлся бы с содержимым на первом же новом действии.
   */
  const actions = useQuery({
    queryKey: ['audit', 'actions'],
    queryFn: () => request<{ actions: string[] }>('/audit/actions'),
    staleTime: 5 * 60_000,
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Действие</span>
          <select
            value={url.get('action')}
            onChange={(event) => {
              url.set({ action: event.target.value, offset: '' });
            }}
            className="h-9 rounded-md border border-input bg-transparent px-2"
          >
            <option value="">любое</option>
            {(actions.data?.actions ?? []).map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Над чем</span>
          <FilterInput
            className="w-[140px]"
            placeholder="тип объекта"
            value={url.get('entityType')}
            onChange={(entityType) => {
              url.set({ entityType, offset: '' });
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Идентификатор объекта</span>
          <FilterInput
            className="num w-[280px]"
            value={url.get('entityId')}
            onChange={(entityId) => {
              url.set({ entityId, offset: '' });
            }}
          />
        </label>

        <PeriodInput
          label="С"
          value={url.get('from')}
          onChange={(value) => {
            url.set({ from: value, offset: '' });
          }}
        />
        <PeriodInput
          label="По"
          value={url.get('to')}
          onChange={(value) => {
            url.set({ to: value, offset: '' });
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

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Когда</TableHead>
              <TableHead className="h-8">Действие</TableHead>
              <TableHead className="h-8">Над чем</TableHead>
              <TableHead className="h-8">Кто</TableHead>
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

            {list.data?.entries.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  По этому отбору записей нет.
                </TableCell>
              </TableRow>
            )}

            {list.data?.entries.map((entry) => (
              <EntryRows
                key={entry.id}
                entry={entry}
                open={opened === entry.id}
                onToggle={() => {
                  setOpened(opened === entry.id ? undefined : entry.id);
                }}
                onFilterEntity={() => {
                  url.set({
                    entityType: entry.entity_type,
                    entityId: entry.entity_id ?? '',
                    offset: '',
                  });
                }}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function EntryRows({
  entry,
  open,
  onToggle,
  onFilterEntity,
}: {
  entry: AuditEntry;
  open: boolean;
  onToggle: () => void;
  onFilterEntity: () => void;
}) {
  return (
    <>
      <TableRow>
        <TableCell>
          <span className="num text-muted-foreground">{moment(entry.occurred_at)}</span>
        </TableCell>
        <TableCell>
          <span className="num">{entry.action}</span>
        </TableCell>
        <TableCell>
          {/* Клик по объекту отбирает журнал по нему: показатель без раскрытия —
              признак поверхностной системы (DESIGN.md). */}
          <button
            type="button"
            onClick={onFilterEntity}
            className="num min-h-6 text-left text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {entry.entity_type}
            {entry.entity_id !== null && (
              <span className="block text-faint">{entry.entity_id}</span>
            )}
          </button>
        </TableCell>
        <TableCell>
          {entry.actor === null ? (
            <span className="text-muted-foreground">платформа</span>
          ) : (
            <>
              <span className="num">{entry.actor.email}</span>
              <span className="block text-faint">
                {entry.actor.full_name}
                {entry.actor_role !== null && ` · ${ROLE_NAME[entry.actor_role]}`}
              </span>
            </>
          )}
        </TableCell>
        <TableCell>
          <Button variant="outline" size="sm" onClick={onToggle} aria-expanded={open}>
            {open ? 'Свернуть' : 'Раскрыть'}
          </Button>
        </TableCell>
      </TableRow>

      {open && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={COLUMNS} className="whitespace-normal">
            <div className="grid gap-3 md:grid-cols-2">
              <Change title="Было" value={entry.before} />
              <Change title="Стало" value={entry.after} />
            </div>
            <div className="pt-2 text-muted-foreground">
              {entry.ip !== null && (
                <span className="num pr-4">
                  адрес источника: <span className="text-foreground">{entry.ip}</span>
                </span>
              )}
              {entry.correlation_id !== null && (
                <span className="num">
                  идентификатор запроса:{' '}
                  <span className="text-foreground">{entry.correlation_id}</span>
                </span>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * Состояние до или после.
 *
 * Показывается как есть, целиком: разбирать спор по формулировке вроде «изменена цена»
 * невозможно, ради этого журнал и хранит изменение полностью.
 */
function Change({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="pb-1 text-muted-foreground">{title}</div>
      {value === null || value === undefined ? (
        <div className="text-faint">—</div>
      ) : (
        <pre className="num overflow-x-auto rounded-md border border-border bg-card p-2">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}
