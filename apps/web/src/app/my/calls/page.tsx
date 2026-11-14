'use client';

import { useQuery } from '@tanstack/react-query';
import {
  CALL_STATUSES,
  type CallStatus,
  type ClientFailureReason,
  type TerminationKind,
} from '@zvonix/shared';
import { Suspense } from 'react';
import { ListenButton, useListenable } from '@/components/call-recording';
import { ConsoleShell } from '@/components/console-shell';
import { ExportButton } from '@/components/export-button';
import { FilterInput } from '@/components/filter-input';
import { LiveSwitch } from '@/components/live-switch';
import { PageNav } from '@/components/page-nav';
import { SavedFilters, useColumnPicker } from '@/components/table-view';
import { useLiveInterval } from '@/lib/live';
import { PeriodInput } from '@/components/period-input';
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
import { duration, moment } from '@/lib/format';
import { money } from '@/lib/money';
import {
  CALL_STATUS_NAME,
  callTone,
  CLIENT_FAILURE_REASON_FIX,
  CLIENT_FAILURE_REASON_NAME,
  TERMINATION_KIND_MEANING,
  TERMINATION_KIND_NAME,
} from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';

const PAGE_SIZE = 50;
const COLUMNS = 7;

/** Сколько цифр должно быть набрано, чтобы номер имело смысл искать. */
const MSISDN_DIGITS = 10;

interface Channel {
  readonly id: string;
  readonly name: string;
}

interface Call {
  readonly id: string;
  readonly destination: string;
  readonly status: CallStatus;
  readonly failure_reason: ClientFailureReason | null;
  readonly duration_seconds: number | null;
  /** Списано за вызов, ₽; пусто — списания не было (отказ или ноль секунд). */
  readonly cost: string | null;
  readonly started_at: string;
  readonly region: string | null;
  readonly channel: { id: string; name: string };
  readonly operator: { id: string; name: string } | null;
  /** Через что ушёл вызов — SIM или SIP; пусто у отказа. */
  readonly termination_kind: TerminationKind | null;
}

export default function MyCallsPage() {
  return (
    <ConsoleShell title="Вызовы" cabinet="client">
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <MyCalls />
        </Suspense>
      )}
    </ConsoleShell>
  );
}

function MyCalls() {
  const url = useUrlState();
  const columns = useColumnPicker('my-calls');
  const offset = Number.parseInt(url.get('offset'), 10) || 0;

  const channels = useQuery({
    // Свой ключ: у страницы «Линии» под `['my', 'channels']` лежит весь ответ, а здесь —
    // только список. Общий ключ с разной формой данных ронял ту страницу (2026-09-30).
    queryKey: ['my', 'channels', 'names'],
    queryFn: async () => (await request<{ channels: Channel[] }>('/client/channels')).channels,
    staleTime: 60_000,
  });

  // Номер уходит в отбор только набранным целиком: половина номера — неразбираемая
  // строка, и API отвечал бы на неё отказом при каждом нажатии клавиши.
  const typedNumber = url.get('destination');
  const digits = typedNumber.replace(/\D/gu, '');
  const numberReady = digits.length >= MSISDN_DIGITS;

  const search = new URLSearchParams(url.query);
  if (!numberReady) search.delete('destination');
  search.set('limit', String(PAGE_SIZE));

  const live = useLiveInterval();
  const list = useQuery({
    queryKey: ['my', 'calls', search.toString()],
    refetchInterval: live,
    queryFn: () => request<{ calls: Call[]; total: number }>(`/client/calls?${search.toString()}`),
  });

  const recordings = useListenable((list.data?.calls ?? []).map((call) => call.id));
  // Линия одна — колонка повторяла бы её имя в каждой строке; она нужна, когда линий несколько.
  const manyLines = (channels.data?.length ?? 0) > 1;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Линия</span>
          <select
            value={url.get('channelId')}
            onChange={(event) => {
              url.set({ channelId: event.target.value, offset: '' });
            }}
            className="h-9 w-[200px] rounded-md border border-input bg-transparent px-2"
          >
            <option value="">любая</option>
            {(channels.data ?? []).map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name}
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
          <SavedFilters />
          {columns.picker}
          <ExportButton
            name="вызовы"
            load={async () => {
              const filters = new URLSearchParams(search);
              filters.delete('offset');
              const found = await loadAllCalls<Call>('/client/calls', filters);
              return {
                header: [
                  'Когда',
                  'Линия',
                  'Куда',
                  'Через что',
                  'Оператор',
                  'Регион',
                  'Итог',
                  'Причина',
                  'Секунд',
                  'Стоимость, ₽',
                ],
                rows: found.rows.map((call) => [
                  moment(call.started_at),
                  call.channel.name,
                  call.destination,
                  call.termination_kind === null
                    ? ''
                    : TERMINATION_KIND_NAME[call.termination_kind],
                  call.operator?.name,
                  call.region,
                  CALL_STATUS_NAME[call.status],
                  call.failure_reason === null
                    ? ''
                    : CLIENT_FAILURE_REASON_NAME[call.failure_reason],
                  call.duration_seconds,
                  call.cost,
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
        <Table {...columns.tableProps}>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Когда</TableHead>
              {manyLines && <TableHead className="h-8">Линия</TableHead>}
              <TableHead className="h-8">Куда</TableHead>
              <TableHead className="h-8">Через что</TableHead>
              <TableHead className="h-8">Итог</TableHead>
              <TableHead className="h-8 text-right">Стоимость</TableHead>
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
                <TableCell colSpan={COLUMNS} className="whitespace-normal text-muted-foreground">
                  По этому отбору вызовов нет. Если звонки шли, а здесь пусто — они не дошли до
                  площадки: проверьте настройки своей АТС.
                </TableCell>
              </TableRow>
            )}

            {list.data?.calls.map((call) => (
              <TableRow key={call.id}>
                <TableCell>
                  <span className="num text-muted-foreground">{moment(call.started_at)}</span>
                </TableCell>

                {manyLines && <TableCell>{call.channel.name}</TableCell>}

                {/* Одной строкой: номер, затем оператор и регион бледно — строка не раздувается в две. */}
                <TableCell className="whitespace-nowrap">
                  <span className="num">{call.destination}</span>
                  <span className="text-faint">
                    {' · '}
                    {call.operator?.name ?? 'оператор не определён'}
                    {call.region !== null && ` · ${call.region}`}
                  </span>
                </TableCell>

                <TableCell
                  title={
                    call.termination_kind === null
                      ? undefined
                      : TERMINATION_KIND_MEANING[call.termination_kind]
                  }
                >
                  {call.termination_kind === null ? (
                    <span className="text-faint">—</span>
                  ) : (
                    TERMINATION_KIND_NAME[call.termination_kind]
                  )}
                </TableCell>

                <TableCell className="whitespace-nowrap">
                  <span className={`rounded-md px-2 py-0.5 ${callTone(call.status)}`}>
                    {CALL_STATUS_NAME[call.status]}
                  </span>
                  {/* Причина — коротко рядом с итогом; что делать — в подсказке: строка не раздувается. */}
                  {call.failure_reason !== null && (
                    <span
                      className="ml-2 cursor-help underline decoration-dotted underline-offset-4"
                      title={CLIENT_FAILURE_REASON_FIX[call.failure_reason]}
                    >
                      {CLIENT_FAILURE_REASON_NAME[call.failure_reason]}
                    </span>
                  )}
                </TableCell>

                <TableCell className="num text-right">
                  {call.cost === null ? <span className="text-faint">—</span> : money(call.cost)}
                </TableCell>

                <TableCell className="num text-right whitespace-nowrap">
                  {/* Длительность и значок записи — в одну строку; нет записи — значка нет. */}
                  <span className="inline-flex items-center justify-end gap-1">
                    {recordings.has(call.id) && (
                      <ListenButton
                        recordingId={recordings.get(call.id) ?? ''}
                        subtitle={`${call.destination} · ${moment(call.started_at)}`}
                      />
                    )}
                    {call.duration_seconds === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      duration(call.duration_seconds)
                    )}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
