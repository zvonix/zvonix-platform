'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CALL_STATUSES, type CallStatus } from '@zvonix/shared';
import { Suspense } from 'react';
import { ListenButton, useListenable } from '@/components/call-recording';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ExportButton } from '@/components/export-button';
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
import { CALL_STATUS_NAME, callTone } from '@/lib/labels';
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
  readonly started_at: string;
}

export default function PartnerCallsPage() {
  return (
    <ConsoleShell title="Вызовы через меня" cabinet="partner">
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
  const filtered = url.get('from') !== '' || url.get('to') !== '' || url.get('status') !== '';

  const search = new URLSearchParams(url.query);
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
      <p className="max-w-prose text-muted-foreground">
        Вызовы, прошедшие через ваше оборудование, — по ним сверяется счёт вашего оператора. Задайте
        тот же период, что в счёте: если разговора за этот период здесь нет, а оператор его
        посчитал, — он шёл не через площадку.
      </p>

      <div className="flex flex-wrap items-end gap-2">
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

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table {...columns.tableProps}>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Когда</TableHead>
              <TableHead className="h-8">Куда</TableHead>
              <TableHead className="h-8">Через что</TableHead>
              <TableHead className="h-8">Итог</TableHead>
              <TableHead className="h-8 text-right">Начислено</TableHead>
              <TableHead className="h-8 text-right">Длительность</TableHead>
              <TableHead className="h-8" />
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
                  {filtered
                    ? 'За этот период и с этим итогом вызовов через ваше оборудование не было.'
                    : 'Вызовов через ваше оборудование пока не было. Если оно подключено и включено, посмотрите «Моё оборудование» и «Мои тарифы»: без регистрации на узле и без цены в тарифе карты вызов не уйдёт вовсе.'}
                </TableCell>
              </TableRow>
            )}

            {list.data?.calls.map((call) => {
              const sim = call.sim_card_id === null ? undefined : sims.get(call.sim_card_id);
              const gateway = call.gateway_id === null ? undefined : gateways.get(call.gateway_id);
              const trunk = call.gateway_id === null ? undefined : trunks.get(call.gateway_id);

              return (
                <TableRow key={call.id}>
                  <TableCell className="num text-muted-foreground">
                    {moment(call.started_at)}
                  </TableCell>

                  <TableCell className="num">{call.destination}</TableCell>

                  <TableCell>
                    {gateway?.name ?? trunk ?? <span className="text-faint">—</span>}
                    {sim !== undefined && (
                      <span className="num block text-faint">
                        {sim.msisdn}
                        {sim.operator_name !== null && ` · ${sim.operator_name}`}
                      </span>
                    )}
                  </TableCell>

                  <TableCell>
                    <span className={`rounded-md px-2 py-0.5 ${callTone(call.status)}`}>
                      {CALL_STATUS_NAME[call.status]}
                    </span>
                  </TableCell>

                  <TableCell className="num text-right">
                    {call.earned === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      money(call.earned)
                    )}
                  </TableCell>

                  <TableCell className="num text-right">
                    {call.duration_seconds === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      duration(call.duration_seconds)
                    )}
                    {recordings.has(call.id) && (
                      <span className="block pt-1">
                        <ListenButton
                          recordingId={recordings.get(call.id) ?? ''}
                          subtitle={`${call.destination} · ${moment(call.started_at)}`}
                        />
                      </span>
                    )}
                  </TableCell>

                  <TableCell className="text-right">
                    <WrongNetwork call={call} />
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
      label="Ушёл не в мою сеть"
      size="xs"
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
