'use client';

import { useQuery } from '@tanstack/react-query';
import { CALL_FAILURE_REASONS, CALL_STATUSES } from '@zvonix/shared';
import type { CallFailureReason, CallStatus } from '@zvonix/shared';
import { Suspense, useState } from 'react';
import { ListenButton, useListenable } from '@/components/call-recording';
import { ConsoleShell } from '@/components/console-shell';
import { ExportButton } from '@/components/export-button';
import { FilterInput } from '@/components/filter-input';
import { LiveSwitch } from '@/components/live-switch';
import { PageNav } from '@/components/page-nav';
import { useLiveInterval } from '@/lib/live';
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
import { loadAllCalls } from '@/lib/csv';
import { useClients, usePartners } from '@/lib/dictionaries';
import { duration, moment } from '@/lib/format';
import { CALL_STATUS_NAME, callTone, FAILURE_REASON_FIX, FAILURE_REASON_NAME } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { CallSummary } from './call-summary';
import { RoutePreview } from './route-preview';

const PAGE_SIZE = 50;
const COLUMNS = 6;

/** Сколько цифр должно быть набрано, чтобы номер вообще имело смысл искать. */
const MSISDN_DIGITS = 10;

interface Call {
  readonly id: string;
  readonly external_id: string;
  readonly destination: string;
  readonly status: CallStatus;
  readonly failure_reason: CallFailureReason | null;
  readonly duration_seconds: number | null;
  readonly started_at: string;
  readonly answered_at: string | null;
  readonly ended_at: string | null;
  readonly region: string | null;
  readonly client: { id: string; name: string };
  readonly channel: { id: string; name: string };
  readonly operator: { id: string; name: string } | null;
  readonly partner: { id: string; name: string; display_name: string | null } | null;
  readonly gateway: { id: string; name: string } | null;
  readonly sim: { id: string; msisdn: string } | null;
}

export default function CallsPage() {
  return (
    <ConsoleShell title="Разбор вызовов" requireRole={['admin', 'support']}>
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <CallsView />
        </Suspense>
      )}
    </ConsoleShell>
  );
}

function CallsView() {
  const url = useUrlState();
  const clients = useClients();
  const partners = usePartners();
  const [checking, setChecking] = useState(false);

  const offset = Number.parseInt(url.get('offset'), 10) || 0;

  // Номер уходит в отбор только набранным целиком: половина номера — не «ничего
  // не найдено», а неразбираемая строка, и API отвечал бы на неё отказом при каждом
  // нажатии клавиши.
  const typedNumber = url.get('destination');
  const digits = typedNumber.replace(/\D/gu, '');
  const numberReady = digits.length >= MSISDN_DIGITS;

  const filters = new URLSearchParams(url.query);
  filters.delete('offset');
  if (!numberReady) filters.delete('destination');
  const filterQuery = filters.toString();

  const search = new URLSearchParams(filters);
  search.set('limit', String(PAGE_SIZE));
  if (offset > 0) search.set('offset', String(offset));

  const live = useLiveInterval();
  const list = useQuery({
    queryKey: ['calls', search.toString()],
    refetchInterval: live,
    queryFn: () => request<{ calls: Call[]; total: number }>(`/calls?${search.toString()}`),
  });

  const recordings = useListenable((list.data?.calls ?? []).map((call) => call.id));

  return (
    <div className="flex flex-col gap-3">
      <CallSummary query={filterQuery} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Период</span>
        {QUICK_PERIODS.map((period) => (
          <Button
            key={period.label}
            variant="outline"
            size="sm"
            onClick={() => {
              url.set({ from: period.from(), to: '', offset: '' });
            }}
          >
            {period.label}
          </Button>
        ))}

        <Button
          variant={checking ? 'default' : 'outline'}
          size="sm"
          className="ml-auto"
          onClick={() => {
            setChecking(!checking);
          }}
          aria-expanded={checking}
        >
          Проверить маршрут
        </Button>
      </div>

      {checking && (
        <div className="rounded-lg border border-border bg-card p-3">
          <RoutePreview />
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Клиент</span>
          <select
            value={url.get('clientId')}
            onChange={(event) => {
              url.set({ clientId: event.target.value, offset: '' });
            }}
            className="h-9 w-[180px] rounded-md border border-input bg-transparent px-2"
          >
            <option value="">любой</option>
            {clients.rows.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Партнёр</span>
          <select
            value={url.get('partnerId')}
            onChange={(event) => {
              url.set({ partnerId: event.target.value, offset: '' });
            }}
            className="h-9 w-[180px] rounded-md border border-input bg-transparent px-2"
          >
            <option value="">любой</option>
            {partners.rows.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Итог</span>
          <select
            value={url.get('status')}
            onChange={(event) => {
              url.set({ status: event.target.value, offset: '' });
            }}
            className="h-9 w-[150px] rounded-md border border-input bg-transparent px-2"
          >
            <option value="">любой</option>
            {CALL_STATUSES.map((status) => (
              <option key={status} value={status}>
                {CALL_STATUS_NAME[status]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Причина отказа</span>
          <select
            value={url.get('failureReason')}
            onChange={(event) => {
              url.set({ failureReason: event.target.value, offset: '' });
            }}
            className="h-9 w-[230px] rounded-md border border-input bg-transparent px-2"
          >
            <option value="">любая</option>
            {CALL_FAILURE_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {FAILURE_REASON_NAME[reason]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Номер</span>
          <FilterInput
            className="num w-[160px]"
            placeholder="целиком"
            value={typedNumber}
            onChange={(destination) => {
              url.set({ destination, offset: '' });
            }}
          />
        </label>

        <PeriodInput
          label="С"
          value={url.get('from')}
          onChange={(from) => {
            url.set({ from, offset: '' });
          }}
        />
        <PeriodInput
          label="По"
          value={url.get('to')}
          onChange={(to) => {
            url.set({ to, offset: '' });
          }}
        />

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <ExportButton
            name="разбор-вызовов"
            load={async () => {
              const found = await loadAllCalls<Call>('/calls', new URLSearchParams(filterQuery));
              return {
                header: [
                  'Когда',
                  'Клиент',
                  'Канал',
                  'Куда',
                  'Оператор',
                  'Регион',
                  'Партнёр',
                  'Шлюз',
                  'SIM',
                  'Итог',
                  'Причина',
                  'Секунд',
                ],
                rows: found.rows.map((call) => [
                  moment(call.started_at),
                  call.client.name,
                  call.channel.name,
                  call.destination,
                  call.operator?.name,
                  call.region,
                  call.partner?.name,
                  call.gateway?.name,
                  call.sim?.msisdn,
                  CALL_STATUS_NAME[call.status],
                  call.failure_reason === null ? '' : FAILURE_REASON_NAME[call.failure_reason],
                  call.duration_seconds,
                ]),
                truncated: found.truncated,
              };
            }}
          />
          <LiveSwitch />
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

      {typedNumber !== '' && !numberReady && (
        <p className="text-warn">
          Номер ищется только целиком: набрано {digits.length} цифр из {MSISDN_DIGITS}.
        </p>
      )}

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
              <TableHead className="h-8">Клиент и канал</TableHead>
              <TableHead className="h-8">Куда</TableHead>
              <TableHead className="h-8">Через кого</TableHead>
              <TableHead className="h-8">Итог</TableHead>
              <TableHead className="h-8 text-right">Длительность</TableHead>
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

            {list.data?.calls.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  По этому отбору вызовов нет.
                </TableCell>
              </TableRow>
            )}

            {list.data?.calls.map((call) => (
              <CallRow
                key={call.id}
                call={call}
                recordingId={recordings.get(call.id)}
                onFilterClient={() => {
                  url.set({ clientId: call.client.id, offset: '' });
                }}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function CallRow({
  call,
  recordingId,
  onFilterClient,
}: {
  call: Call;
  recordingId: string | undefined;
  onFilterClient: () => void;
}) {
  return (
    <TableRow>
      <TableCell>
        <span className="num text-muted-foreground">{moment(call.started_at)}</span>
      </TableCell>

      <TableCell>
        {/* Клик по клиенту отбирает вызовы по нему: разбор обращения начинается
            с одной строки и продолжается по всему клиенту (DESIGN.md). */}
        <button
          type="button"
          onClick={onFilterClient}
          className="text-left underline-offset-2 hover:underline"
        >
          {call.client.name}
        </button>
        <span className="block text-faint">{call.channel.name}</span>
      </TableCell>

      <TableCell>
        <span className="num">{call.destination}</span>
        <span className="block text-faint">
          {call.operator?.name ?? 'оператор не определён'}
          {call.region !== null && ` · ${call.region}`}
        </span>
      </TableCell>

      <TableCell>
        {call.partner === null ? (
          <span className="text-faint">до выбора не дошло</span>
        ) : (
          <>
            {call.partner.name}
            <span className="block text-faint">
              {call.gateway?.name ?? '—'}
              {call.sim !== null && ` · ${call.sim.msisdn}`}
            </span>
          </>
        )}
      </TableCell>

      <TableCell className="whitespace-normal">
        <span className={`rounded-md px-2 py-0.5 ${callTone(call.status)}`}>
          {CALL_STATUS_NAME[call.status]}
        </span>
        {call.failure_reason !== null && (
          <span className="block pt-0.5" title={FAILURE_REASON_FIX[call.failure_reason]}>
            {FAILURE_REASON_NAME[call.failure_reason]}
          </span>
        )}
      </TableCell>

      <TableCell className="num text-right">
        {call.duration_seconds === null ? (
          <span className="text-faint">—</span>
        ) : (
          duration(call.duration_seconds)
        )}
        {recordingId !== undefined && <ListenButton recordingId={recordingId} />}
      </TableCell>
    </TableRow>
  );
}

/** Быстрые границы периода. Момент вычисляется по нажатию — окно фиксируется тогда же. */
const QUICK_PERIODS = [
  { label: 'час', from: () => since(60 * 60_000) },
  { label: 'сутки', from: () => since(24 * 60 * 60_000) },
  { label: 'неделя', from: () => since(7 * 24 * 60 * 60_000) },
  { label: 'всё время', from: () => '' },
] as const;

function since(milliseconds: number): string {
  return new Date(Date.now() - milliseconds).toISOString();
}
