'use client';

import { useQuery } from '@tanstack/react-query';
import { CALL_FAILURE_REASONS, CALL_STATUSES } from '@zvonix/shared';
import type {
  CallCutOffReason,
  CallFailureReason,
  CallStatus,
  TerminationKind,
} from '@zvonix/shared';
import { Suspense, useState } from 'react';
import { EndCause, ListenButton, useListenable } from '@/components/call-recording';
import { ConsoleShell } from '@/components/console-shell';
import { ExportButton } from '@/components/export-button';
import { FilterInput } from '@/components/filter-input';
import { LiveSwitch } from '@/components/live-switch';
import { PageNav } from '@/components/page-nav';
import { SavedFilters, useColumnPicker } from '@/components/table-view';
import { LIVE_BY_DEFAULT, useLiveInterval } from '@/lib/live';
import { ListPeriodPicker } from '@/components/period-picker';
import {
  INCIDENT_PERIODS,
  listPeriodParams,
  listPeriodSearch,
  readListPeriod,
} from '@/lib/list-period';
import { ClippedText, HintText, StatusDot, toneOf } from '@/components/status-dot';
import { HEAD, NUM, TABLE_FRAME } from '@/components/table-parts';
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
import { money, moneyTotal } from '@/lib/money';
import {
  CALL_CUT_OFF_FIX,
  CALL_CUT_OFF_NAME,
  CALL_STATUS_NAME,
  callTone,
  FAILURE_REASON_FIX,
  FAILURE_REASON_NAME,
  TERMINATION_KIND_NAME,
} from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { CallSummary } from './call-summary';
import { RoutePreview } from './route-preview';

const PAGE_SIZE = 50;
const COLUMNS = 7;

/** Сколько цифр должно быть набрано, чтобы номер вообще имело смысл искать. */
const MSISDN_DIGITS = 10;

interface Call {
  readonly id: string;
  readonly external_id: string;
  readonly destination: string;
  readonly status: CallStatus;
  readonly failure_reason: CallFailureReason | null;
  /** Почему площадка оборвала разговор (ADR-0126); пусто — не обрывали. */
  readonly cut_off_reason: CallCutOffReason | null;
  readonly duration_seconds: number | null;
  /** Деньги вызова по его проводке; пусто — проводки нет (отказ, ноль секунд). */
  readonly money: { client: string; partner: string; margin: string } | null;
  readonly started_at: string;
  readonly answered_at: string | null;
  readonly ended_at: string | null;
  readonly region: string | null;
  readonly client: { id: string; name: string };
  readonly channel: { id: string; name: string };
  readonly operator: { id: string; name: string } | null;
  readonly partner: { id: string; name: string; display_name: string | null } | null;
  readonly gateway: { id: string; name: string } | null;
  /** Через что ушёл вызов — SIM или SIP; пусто у отказа. */
  readonly termination_kind: TerminationKind | null;
  readonly sim: { id: string; msisdn: string } | null;
  readonly end_cause: string | null;
  readonly end_sip: string | null;
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
  const columns = useColumnPicker('calls');
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

  // Период из адреса — моментами `from`/`to`, как их ждёт API (lib/list-period.ts).
  const filters = listPeriodSearch(url.query);
  filters.delete('offset');
  if (!numberReady) filters.delete('destination');
  const filterQuery = filters.toString();

  const search = new URLSearchParams(filters);
  search.set('limit', String(PAGE_SIZE));
  if (offset > 0) search.set('offset', String(offset));

  const live = useLiveInterval(LIVE_BY_DEFAULT);
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
        {/* Тот же выбор периода, что в сводках; «Час» и «Сутки» — последние 60 минут и 24 часа (разбор инцидента). */}
        <ListPeriodPicker
          value={readListPeriod(url.get)}
          options={INCIDENT_PERIODS}
          onChange={(period) => {
            url.set({ ...listPeriodParams(period), offset: '' });
          }}
        />

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

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <SavedFilters />
          {columns.picker}
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
                  'Списано с клиента, ₽',
                  'Партнёру, ₽',
                  'Площадке, ₽',
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
                  call.cut_off_reason !== null
                    ? CALL_CUT_OFF_NAME[call.cut_off_reason]
                    : call.failure_reason === null
                      ? ''
                      : FAILURE_REASON_NAME[call.failure_reason],
                  call.duration_seconds,
                  call.money?.client,
                  call.money?.partner,
                  call.money?.margin,
                ]),
                truncated: found.truncated,
              };
            }}
          />
          <LiveSwitch pageDefault={LIVE_BY_DEFAULT} />
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
              <TableHead className={HEAD}>Клиент и канал</TableHead>
              <TableHead className={HEAD}>Куда</TableHead>
              <TableHead className={HEAD}>Через кого</TableHead>
              <TableHead className={HEAD}>Итог</TableHead>
              <TableHead className={`${HEAD} text-right`}>Деньги</TableHead>
              <TableHead className={`${HEAD} text-right`}>Длительность</TableHead>
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

      {/* Строка — одна линия: второстепенное — в подсказке, а не хвостом « · » (DESIGN.md, «Таблица»). */}
      <TableCell className="whitespace-nowrap">
        {/* Клик по клиенту отбирает вызовы по нему: разбор обращения начинается
            с одной строки и продолжается по всему клиенту (DESIGN.md). */}
        <button
          type="button"
          onClick={onFilterClient}
          className="text-left underline-offset-2 hover:underline"
          title={`Канал «${call.channel.name}» — показать все вызовы клиента`}
        >
          {call.client.name}
        </button>
      </TableCell>

      <TableCell className="whitespace-nowrap">
        <HintText
          label={call.destination}
          reason={[call.operator?.name ?? 'оператор не определён', call.region]
            .filter(Boolean)
            .join(', ')}
        />
      </TableCell>

      {/* Длинное имя шлюза обрезается многоточием, целиком — в подсказке: таблица не уезжает вбок. */}
      <TableCell>
        {call.partner === null ? (
          <span className="text-faint">до выбора не дошло</span>
        ) : (
          <ClippedText
            text={call.partner.name}
            width="max-w-[220px]"
            hint={[
              call.partner.name,
              call.termination_kind === null ? null : TERMINATION_KIND_NAME[call.termination_kind],
              call.gateway?.name,
              call.sim?.msisdn,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        )}
      </TableCell>

      {/* Итог — точкой и словом; почему не состоялся и что делать — в подсказке (DESIGN.md, «Таблица»). */}
      <TableCell className="max-w-[300px] truncate">
        <StatusDot
          tone={call.cut_off_reason === null ? toneOf(callTone(call.status)) : 'warn'}
          // Разбор вызовов: причина отказа или обрыва видна сразу — словом у точки, что делать — в подсказке.
          label={
            call.cut_off_reason !== null
              ? CALL_CUT_OFF_NAME[call.cut_off_reason]
              : call.failure_reason === null
                ? CALL_STATUS_NAME[call.status]
                : FAILURE_REASON_NAME[call.failure_reason]
          }
          reason={
            call.cut_off_reason !== null
              ? `${CALL_STATUS_NAME[call.status]}. ${CALL_CUT_OFF_FIX[call.cut_off_reason]}`
              : call.failure_reason === null
                ? undefined
                : `${CALL_STATUS_NAME[call.status]}. ${FAILURE_REASON_FIX[call.failure_reason]}`
          }
        />
        <EndCause cause={call.end_cause} sip={call.end_sip} status={call.status} />
      </TableCell>

      <TableCell className={`${NUM} whitespace-nowrap`}>
        {call.money === null ? (
          <span className="text-faint">—</span>
        ) : (
          <HintText
            label={moneyTotal(call.money.client)}
            reason={`Списано с клиента ${money(call.money.client)}; партнёру ${money(call.money.partner)}; площадке ${money(call.money.margin)}`}
          />
        )}
      </TableCell>

      <TableCell className={`${NUM} whitespace-nowrap`}>
        <span className="inline-flex items-center justify-end gap-1">
          {recordingId !== undefined && (
            <ListenButton
              recordingId={recordingId}
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
  );
}
