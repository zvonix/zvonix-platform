'use client';

import { useQuery } from '@tanstack/react-query';
import { CALL_STATUSES, type CallStatus, type ClientFailureReason } from '@zvonix/shared';
import { Suspense } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { FilterInput } from '@/components/filter-input';
import { PageNav } from '@/components/page-nav';
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
import { duration, moment } from '@/lib/format';
import {
  CALL_STATUS_NAME,
  callTone,
  CLIENT_FAILURE_REASON_FIX,
  CLIENT_FAILURE_REASON_NAME,
} from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';

const PAGE_SIZE = 50;
const COLUMNS = 5;

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
  readonly started_at: string;
  readonly region: string | null;
  readonly channel: { id: string; name: string };
  readonly operator: { id: string; name: string } | null;
}

export default function MyCallsPage() {
  return (
    <ConsoleShell title="Вызовы" requireRole="client">
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
  const offset = Number.parseInt(url.get('offset'), 10) || 0;

  const channels = useQuery({
    queryKey: ['my', 'channels'],
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

  const list = useQuery({
    queryKey: ['my', 'calls', search.toString()],
    queryFn: () => request<{ calls: Call[]; total: number }>(`/client/calls?${search.toString()}`),
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">
        Каждая попытка вызова, включая несостоявшиеся. У отказа названа причина и то, что с ней
        делать: часть из них — ваши настройки и деньги, часть — наша сторона.
      </p>

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
              <TableHead className="h-8">Линия</TableHead>
              <TableHead className="h-8">Куда</TableHead>
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

                <TableCell>{call.channel.name}</TableCell>

                <TableCell>
                  <span className="num">{call.destination}</span>
                  <span className="block text-faint">
                    {call.operator?.name ?? 'оператор не определён'}
                    {call.region !== null && ` · ${call.region}`}
                  </span>
                </TableCell>

                <TableCell className="whitespace-normal">
                  <span className={`rounded-md px-2 py-0.5 ${callTone(call.status)}`}>
                    {CALL_STATUS_NAME[call.status]}
                  </span>
                  {call.failure_reason !== null && (
                    <>
                      <span className="block pt-0.5">
                        {CLIENT_FAILURE_REASON_NAME[call.failure_reason]}
                      </span>
                      <span className="block text-muted-foreground">
                        {CLIENT_FAILURE_REASON_FIX[call.failure_reason]}
                      </span>
                    </>
                  )}
                </TableCell>

                <TableCell className="num text-right">
                  {call.duration_seconds === null ? (
                    <span className="text-faint">—</span>
                  ) : (
                    duration(call.duration_seconds)
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
