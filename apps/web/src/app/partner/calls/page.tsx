'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CALL_STATUSES, type CallStatus } from '@zvonix/shared';
import Link from 'next/link';
import { Suspense } from 'react';
import { Flag } from 'lucide-react';
import { ListenButton, useListenable } from '@/components/call-recording';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ExportButton } from '@/components/export-button';
import { Hint } from '@/components/hint';
import { LiveSwitch } from '@/components/live-switch';
import { PageNav } from '@/components/page-nav';
import { SavedFilters, useColumnPicker } from '@/components/table-view';
import { useLiveInterval } from '@/lib/live';
import { ListPeriodPicker } from '@/components/period-picker';
import { listPeriodParams, listPeriodSearch, readListPeriod } from '@/lib/list-period';
import { HintText, StatusDot, toneOf } from '@/components/status-dot';
import { NUM, ROW_ICON, RowActions, TABLE_FRAME, WIDE_ONLY } from '@/components/table-parts';
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
import { MoneyTotal } from '@/components/money-total';
import { CALL_STATUS_NAME, callTone, endCauseName } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import {
  EQUIPMENT_KEY,
  simsOf,
  type Equipment,
  type Gateway,
  type Sim,
} from '../equipment/equipment';

const PAGE_SIZE = 50;
const COLUMNS = 7;

/**
 * Вызов так, как его видит партнёр.
 *
 * Ни клиента, ни линии: через чьё железо прошёл вызов — вопрос партнёра, кто его
 * заказал — не его дело. Обратная сторона ADR-0014 работает так же.
 */
interface PartnerCall {
  readonly id: string;
  readonly destination: string;
  readonly status: CallStatus;
  readonly sim_card_id: string | null;
  readonly gateway_id: string | null;
  readonly operator_id: string | null;
  readonly duration_seconds: number | null;
  /** Начислено партнёру за вызов, ₽; пусто — начисления не было. */
  readonly earned: string | null;
  readonly end_cause: string | null;
  readonly end_sip: string | null;
  readonly started_at: string;
}

export default function PartnerCallsPage() {
  return (
    <ConsoleShell title="Вызовы" cabinet="partner">
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <PartnerCalls />
        </Suspense>
      )}
    </ConsoleShell>
  );
}

/**
 * Вызовы страницами и за период.
 *
 * Раньше приходили последние двести без страниц, а текст обещал полноту: «если разговора
 * здесь нет — он шёл не через площадку». За двумястами это было неправдой, а сверка
 * со счётом оператора — главное, ради чего экран открывают (ui-review, 2026-09-14).
 * Период и страница живут в адресе, как во всех списках кабинета.
 */
function PartnerCalls() {
  const url = useUrlState();
  const columns = useColumnPicker('partner-calls');
  const offset = Number.parseInt(url.get('offset'), 10) || 0;
  const filtered = !('all' in readListPeriod(url.get)) || url.get('status') !== '';

  const search = listPeriodSearch(url.query);
  search.set('limit', String(PAGE_SIZE));

  const live = useLiveInterval();
  const list = useQuery({
    queryKey: ['partner', 'calls', search.toString()],
    refetchInterval: live,
    queryFn: () =>
      request<{ calls: PartnerCall[]; total: number }>(`/partner/calls?${search.toString()}`),
  });

  const recordings = useListenable((list.data?.calls ?? []).map((call) => call.id));

  // Названия железа берутся из того же ответа, что и раздел «оборудование»: второй
  // список имён разъехался бы с первым, а идентификатор в таблице не говорит ничего.
  const equipment = useQuery({
    queryKey: EQUIPMENT_KEY,
    queryFn: () => request<Equipment>('/partner/equipment'),
    staleTime: 60_000,
  });

  const gateways = new Map<string, Gateway>(
    (equipment.data?.gateways ?? []).map((gateway) => [gateway.id, gateway]),
  );
  const trunks = new Map<string, string>(
    (equipment.data?.trunks ?? []).map((trunk) => [trunk.id, trunk.name]),
  );
  const sims = new Map<string, Sim>(simsOf(equipment.data).map((sim) => [sim.id, sim]));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        {/* Пояснение — за «?», а не абзацем над таблицей (осмотр 2026-10-21). */}
        <Hint label="Как сверить со счётом оператора">
          <p>
            Вызовы, прошедшие через ваше оборудование, — по ним сверяется счёт вашего оператора.
            Задайте тот же период, что в счёте: если разговора за этот период здесь нет, а оператор
            его посчитал, — он шёл не через площадку.
          </p>
        </Hint>
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
            name="вызовы-через-меня"
            load={async () => {
              const filters = new URLSearchParams(search);
              filters.delete('offset');
              const found = await loadAllCalls<PartnerCall>('/partner/calls', filters);
              return {
                header: ['Когда', 'Куда', 'Шлюз', 'SIM', 'Итог', 'Секунд', 'Начислено, ₽'],
                rows: found.rows.map((call) => {
                  const sim = call.sim_card_id === null ? undefined : sims.get(call.sim_card_id);
                  const where =
                    call.gateway_id === null
                      ? undefined
                      : (gateways.get(call.gateway_id)?.name ?? trunks.get(call.gateway_id));
                  return [
                    moment(call.started_at),
                    call.destination,
                    where,
                    sim?.msisdn,
                    CALL_STATUS_NAME[call.status],
                    call.duration_seconds,
                    call.earned,
                  ];
                }),
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

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className={TABLE_FRAME}>
        <Table {...columns.tableProps}>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className={`h-8 ${WIDE_ONLY}`}>Когда</TableHead>
              <TableHead className="h-8">Куда</TableHead>
              <TableHead className={`h-8 ${WIDE_ONLY}`}>Через что</TableHead>
              <TableHead className="h-8">Итог</TableHead>
              <TableHead className="h-8 text-right">Начислено</TableHead>
              <TableHead className={`h-8 text-right ${WIDE_ONLY}`}>Длительность</TableHead>
              <TableHead className="h-8 w-px">
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
                  {filtered ? (
                    'За этот период и с этим итогом вызовов через ваше оборудование не было.'
                  ) : (
                    <>
                      Вызовов пока не было. Проверьте{' '}
                      <Link href="/partner/equipment" className="underline underline-offset-2">
                        оборудование
                      </Link>{' '}
                      (шлюз на связи) и{' '}
                      <Link href="/partner/prices" className="underline underline-offset-2">
                        тарифы
                      </Link>{' '}
                      (есть цена для карт).
                    </>
                  )}
                </TableCell>
              </TableRow>
            )}

            {list.data?.calls.map((call) => {
              const sim = call.sim_card_id === null ? undefined : sims.get(call.sim_card_id);
              const gateway = call.gateway_id === null ? undefined : gateways.get(call.gateway_id);
              const trunk = call.gateway_id === null ? undefined : trunks.get(call.gateway_id);

              return (
                <TableRow key={call.id}>
                  <TableCell className={`num text-muted-foreground ${WIDE_ONLY}`}>
                    {moment(call.started_at)}
                  </TableCell>

                  <TableCell className="num">{call.destination}</TableCell>

                  <TableCell className={WIDE_ONLY}>
                    <Through name={gateway?.name ?? trunk} sim={sim} />
                  </TableCell>

                  <TableCell>
                    <StatusDot
                      tone={toneOf(callTone(call.status))}
                      label={CALL_STATUS_NAME[call.status]}
                      reason={endReason(call)}
                    />
                  </TableCell>

                  <TableCell className={NUM}>
                    {call.earned === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <MoneyTotal value={call.earned} />
                    )}
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
                      <WrongNetwork call={call} />
                    </RowActions>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * Шлюз или SIP-провайдер, через который прошёл вызов; номер карты и её оператор — в подсказке, чтобы строка
 * оставалась в одну линию ([DESIGN.md](../../../../../docs/DESIGN.md), «Таблица»).
 */
function Through({ name, sim }: { name: string | undefined; sim: Sim | undefined }) {
  if (name === undefined) return <span className="text-faint">—</span>;
  if (sim === undefined) return <span className="whitespace-nowrap">{name}</span>;
  const operator = sim.operator_name === null ? '' : `, ${sim.operator_name}`;
  return <HintText label={name} reason={`SIM ${sim.msisdn}${operator}`} />;
}

/** Почему вызов не состоялся — подсказкой у точки итога, с кодом узла для разбора. */
function endReason(call: PartnerCall): string | undefined {
  if (call.end_cause === null || call.status === 'completed') return undefined;
  const sip = call.end_sip === null ? '' : `; ответ: ${call.end_sip}`;
  return `${endCauseName(call.end_cause)} (код узла: ${call.end_cause}${sip})`;
}

/**
 * «Этот вызов ушёл не в мою сеть».
 *
 * Партнёр видит счёт своего оператора и знает об ошибке раньше площадки: у него это
 * деньги, у нас строка в базе. Обращение отменяет определение оператора для номера
 * немедленно, не дожидаясь срока годности записи
 * ([ADR-0013](../../../../../docs/adr/0013-opredelenie-operatora.md)).
 *
 * Через подтверждение: последствие раньше жило только во всплывающей подсказке,
 * а на телефоне — основном устройстве партнёра — подсказок нет.
 *
 * Показывается только у состоявшихся разговоров: несостоявшийся вызов оператор
 * не тарифицирует, и отменять по нему нечего.
 */
function WrongNetwork({ call }: { call: PartnerCall }) {
  const queryClient = useQueryClient();

  const report = useMutation({
    mutationFn: () =>
      request<{ invalidated: boolean; destination: string }>(`/calls/${call.id}/wrong-network`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['partner', 'calls'] });
    },
  });

  if (call.status !== 'completed') return null;

  if (report.isSuccess) {
    return <span className="text-muted-foreground">принято</span>;
  }

  return (
    <ConfirmAction
      label={<Flag aria-hidden className="size-4" />}
      tooltip="Ушёл не в мою сеть"
      {...ROW_ICON}
      tone="neutral"
      title={`Вызов на ${call.destination} ушёл не в вашу сеть`}
      consequence={
        <>
          <p>
            Оператор этого номера будет определён заново: прежняя запись отменяется сразу, а сам
            вызов площадка разберёт.
          </p>
          <p>
            Обращений принимается не больше пятидесяти в час — отмечайте те, что видите в счёте
            оператора.
          </p>
        </>
      }
      confirmLabel="Сообщить"
      onConfirm={() => report.mutateAsync()}
    />
  );
}
