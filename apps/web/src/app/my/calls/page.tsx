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
import { ListPeriodPicker } from '@/components/period-picker';
import { listPeriodParams, listPeriodSearch, readListPeriod } from '@/lib/list-period';
import { HintText, StatusDot, toneOf } from '@/components/status-dot';
import { HEAD, NUM, RowActions, TABLE_FRAME, WIDE_ONLY } from '@/components/table-parts';
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
const COLUMNS = 8;

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

  const search = listPeriodSearch(url.query);
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

        <ListPeriodPicker
          value={readListPeriod(url.get)}
          onChange={(period) => {
            url.set({ ...listPeriodParams(period), offset: '' });
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

      <div className={TABLE_FRAME}>
        <Table {...columns.tableProps}>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className={HEAD}>Когда</TableHead>
              {manyLines && <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Линия</TableHead>}
              <TableHead className={HEAD}>Куда</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Через что</TableHead>
              <TableHead className={HEAD}>Итог</TableHead>
              <TableHead className={`${HEAD} text-right`}>Стоимость</TableHead>
              <TableHead className={`${HEAD} text-right ${WIDE_ONLY}`}>Длительность</TableHead>
              <TableHead className={`${HEAD} w-px`}>
                <span className="sr-only">Действия</span>
              </TableHead>
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

                {manyLines && (
                  <TableCell className={`whitespace-nowrap ${WIDE_ONLY}`}>
                    {call.channel.name}
                  </TableCell>
                )}

                {/* Номер, а оператор и регион — в подсказке к нему: строка в одну линию без хвоста « · ». */}
                <TableCell>
                  <HintText
                    label={call.destination}
                    reason={`${call.operator?.name ?? 'оператор не определён'}${call.region === null ? '' : `, ${call.region}`}`}
                  />
                </TableCell>

                <TableCell
                  className={WIDE_ONLY}
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

                {/* Клиенту причина отказа важнее слова «Не состоялся» (DESIGN.md, «Три аудитории»): она и стоит у
                    точки, а что сделать — в подсказке. */}
                <TableCell>
                  <StatusDot
                    tone={toneOf(callTone(call.status))}
                    label={
                      call.failure_reason === null
                        ? CALL_STATUS_NAME[call.status]
                        : CLIENT_FAILURE_REASON_NAME[call.failure_reason]
                    }
                    reason={
                      call.failure_reason === null
                        ? undefined
                        : `${CALL_STATUS_NAME[call.status]}. ${CLIENT_FAILURE_REASON_FIX[call.failure_reason]}`
                    }
                  />
                </TableCell>

                <TableCell className={NUM}>
                  {call.cost === null ? <span className="text-faint">—</span> : money(call.cost)}
                </TableCell>

                <TableCell className={`${NUM} ${WIDE_ONLY}`}>
                  {call.duration_seconds === null ? (
                    <span className="text-faint">—</span>
                  ) : (
                    duration(call.duration_seconds)
                  )}
                </TableCell>

                <TableCell>
                  <RowActions>
                    {recordings.has(call.id) && (
                      <ListenButton
                        recordingId={recordings.get(call.id) ?? ''}
                        subtitle={`${call.destination} · ${moment(call.started_at)}`}
                      />
                    )}
                  </RowActions>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
