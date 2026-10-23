'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { BarChart } from '@/components/bar-chart';
import { ErrorNote } from '@/components/error-note';
import { ExportButton } from '@/components/export-button';
import { FilterInput } from '@/components/filter-input';
import { Hint } from '@/components/hint';
import { PageNav } from '@/components/page-nav';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, request } from '@/lib/api';
import { loadAllRows } from '@/lib/csv';
import { moment, plural } from '@/lib/format';
import { MESSAGE_FAILURE_NAME } from '@/lib/labels';
import { money } from '@/lib/money';
import { REPORT_PERIODS } from '@/lib/reports';

interface Counts {
  readonly started: number;
  readonly restarted: number;
  readonly phone_shared: number;
  readonly stopped: number;
}

interface BotStats {
  readonly events: Counts & { readonly net: number };
  readonly now: { readonly subscribed: number; readonly with_phone: number };
  readonly funnel: { started: number; shared: number; received: number; stopped: number };
  readonly daily: (Counts & { readonly day: string })[];
  readonly messages: { total: number; delivered: number; failed: number; cost: string };
  readonly failures: { reason: string; n: number }[];
  readonly median_seconds_to_phone: number | null;
}

interface Subscriber {
  readonly id: string;
  readonly first_name: string | null;
  readonly phone: string | null;
  readonly state: string;
  readonly since: string;
  readonly messages: number;
  readonly last_message_at: string | null;
}

const PAGE = 50;

/** Начало периода: «Сегодня» — с начала суток человека, иначе — последние N суток. */
function periodStart(days: number): string {
  const now = new Date();
  if (days === 1) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.toISOString();
  }
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

const shortDay = (day: string): string => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const share = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${String(Math.round((part * 100) / whole))} %`;

function duration(seconds: number): string {
  if (seconds < 60) return `${String(seconds)} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} мин`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)} ч ${String(minutes % 60)} мин`;
}

/**
 * Статистика бота MAX клиента ([ADR-0099](../../../../docs/adr/0099-istoriya-podpischikov-bota.md)): за период — запуски, номера,
 * остановки, воронка, сообщения через бота и подписчики. Одна и та же у клиента и у сотрудников — разные адреса API.
 */
export function BotStats({ base }: { base: string }) {
  const [days, setDays] = useState(7);
  const [phone, setPhone] = useState('');
  const [offset, setOffset] = useState(0);

  const from = periodStart(days);
  const stats = useQuery({
    queryKey: ['bot-stats', base, days],
    queryFn: ({ signal }) =>
      request<BotStats>(
        `${base}/stats?from=${encodeURIComponent(from)}&offset=${String(-new Date().getTimezoneOffset())}`,
        { signal },
      ),
  });
  const filters = new URLSearchParams();
  if (phone !== '') filters.set('phone', phone);
  const list = useQuery({
    queryKey: ['bot-subscribers', base, phone, offset],
    queryFn: ({ signal }) => {
      const query = new URLSearchParams(filters);
      query.set('limit', String(PAGE));
      query.set('offset', String(offset));
      return request<{ subscribers: Subscriber[]; total: number }>(
        `${base}/subscribers?${query.toString()}`,
        { signal },
      );
    },
  });
  const error = [stats.error, list.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );
  const data = stats.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Статистика бота</h2>
        <Hint label="Откуда цифры">
          <p>
            «Запустили» — впервые открыли бота по вашей ссылке, «вернулись» — запустили снова после
            остановки. «Остановили» — остановили бота, удалили чат или ответили «СТОП».
          </p>
          <p className="mt-2">
            Воронка — по тем, кто впервые запустил бота в выбранном периоде: что с ними стало к
            сегодняшнему дню.
          </p>
          <p className="mt-2">
            Номера и остановки записываются с обновления 0.1.163; до него известна только дата
            подписки.
          </p>
        </Hint>
        <div
          className="ml-auto flex flex-wrap gap-0.5 rounded-md border border-border bg-muted p-0.5"
          role="group"
          aria-label="Период"
        >
          {REPORT_PERIODS.map((period) => (
            <button
              key={period.days}
              type="button"
              aria-pressed={days === period.days}
              onClick={() => {
                setDays(period.days);
              }}
              className={`rounded px-2.5 py-1.5 ${days === period.days ? 'bg-card font-semibold shadow-[0_0_0_1px_var(--border)]' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {period.label}
            </button>
          ))}
        </div>
      </div>

      {error !== undefined && <ErrorNote error={error} />}

      {data !== undefined && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            <Tile label="Запустили" value={String(data.events.started)} />
            <Tile label="Вернулись" value={String(data.events.restarted)} />
            <Tile label="Поделились номером" value={String(data.events.phone_shared)} />
            <Tile label="Остановили" value={String(data.events.stopped)} />
            <Tile
              label="Прирост"
              value={`${data.events.net > 0 ? '+' : ''}${String(data.events.net)}`}
              tone={data.events.net < 0 ? 'text-crit' : data.events.net > 0 ? 'text-ok' : undefined}
            />
            <Tile
              label="Подписаны сейчас"
              value={String(data.now.subscribed)}
              note={`с номером ${String(data.now.with_phone)} (${share(data.now.with_phone, data.now.subscribed)})`}
            />
          </div>

          <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
            <h3 className="font-medium">Воронка</h3>
            <Funnel
              steps={[
                ['Запустили', data.funnel.started],
                ['Поделились номером', data.funnel.shared],
                ['Получили сообщение', data.funnel.received],
                ['Остановили', data.funnel.stopped],
              ]}
            />
            {data.median_seconds_to_phone !== null && (
              <p className="text-muted-foreground">
                Номер обычно дают через {duration(data.median_seconds_to_phone)} после запуска.
              </p>
            )}
          </section>

          {data.daily.length > 1 && (
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="flex flex-col gap-2">
                <h3 className="font-medium">Запустили и вернулись по дням</h3>
                <BarChart
                  bars={data.daily.map((row) => ({
                    label: shortDay(row.day),
                    value: row.started + row.restarted,
                    title: `${shortDay(row.day)}: запустили ${String(row.started)}, вернулись ${String(row.restarted)}, номер ${String(row.phone_shared)}`,
                  }))}
                  peak={`За период: ${String(data.events.started + data.events.restarted)}`}
                  summary="Запуски бота по дням"
                />
              </section>
              <section className="flex flex-col gap-2">
                <h3 className="font-medium">Остановили по дням</h3>
                <BarChart
                  bars={data.daily.map((row) => ({
                    label: shortDay(row.day),
                    value: row.stopped,
                    title: `${shortDay(row.day)}: остановили ${String(row.stopped)}`,
                  }))}
                  peak={`За период: ${String(data.events.stopped)}`}
                  summary="Остановки бота по дням"
                />
              </section>
            </div>
          )}

          <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
            <h3 className="font-medium">Сообщения через бота</h3>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span>
                Принято <span className="num font-semibold">{String(data.messages.total)}</span>
              </span>
              <span>
                Доставлено{' '}
                <span className="num font-semibold">{String(data.messages.delivered)}</span>
              </span>
              <span>
                Не отправлено{' '}
                <span className="num font-semibold">{String(data.messages.failed)}</span>
              </span>
              <span>
                Стоимость <span className="num font-semibold">{money(data.messages.cost)}</span>
              </span>
            </div>
            {data.failures.length > 0 && (
              <ul className="text-muted-foreground">
                {data.failures.map((failure) => (
                  <li key={failure.reason}>
                    {MESSAGE_FAILURE_NAME[failure.reason] ?? failure.reason}:{' '}
                    <span className="num">{String(failure.n)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <h3 className="font-medium">Подписчики</h3>
          <FilterInput
            value={phone}
            placeholder="часть номера"
            className="w-[200px]"
            onChange={(value) => {
              setPhone(value.replace(/\D/gu, ''));
              setOffset(0);
            }}
          />
          <div className="ml-auto">
            <ExportButton
              name="подписчики-бота"
              load={async () => {
                const found = await loadAllRows<Subscriber>(
                  `${base}/subscribers`,
                  filters,
                  'subscribers',
                );
                return {
                  header: ['Имя', 'Номер', 'С какого числа', 'Состояние', 'Сообщений', 'Последнее'],
                  rows: found.rows.map((row) => [
                    row.first_name ?? '',
                    row.phone ?? '',
                    moment(row.since),
                    row.state === 'started' ? 'подписан' : 'остановил',
                    row.messages,
                    row.last_message_at === null ? '' : moment(row.last_message_at),
                  ]),
                  truncated: found.truncated,
                };
              }}
            />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="text-muted-foreground hover:bg-transparent">
                <TableHead className="h-8">Имя</TableHead>
                <TableHead className="h-8">Номер</TableHead>
                <TableHead className="h-8">С какого числа</TableHead>
                <TableHead className="h-8">Состояние</TableHead>
                <TableHead className="h-8 text-right">Сообщений</TableHead>
                <TableHead className="h-8">Последнее</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data?.subscribers.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="text-muted-foreground">
                    {phone === '' ? 'Подписчиков пока нет.' : 'По этому номеру подписчиков нет.'}
                  </TableCell>
                </TableRow>
              )}
              {list.data?.subscribers.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.first_name ?? <span className="text-faint">—</span>}</TableCell>
                  <TableCell>
                    {row.phone === null ? (
                      <span className="text-faint">не поделился</span>
                    ) : (
                      <span className="num">{row.phone}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="num text-muted-foreground">{moment(row.since)}</span>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`rounded-md px-2 py-0.5 ${row.state === 'started' ? 'bg-ok-soft text-ok' : 'bg-muted text-muted-foreground'}`}
                    >
                      {row.state === 'started' ? 'Подписан' : 'Остановил'}
                    </span>
                  </TableCell>
                  <TableCell className="num text-right">{String(row.messages)}</TableCell>
                  <TableCell>
                    <span className="num text-muted-foreground">
                      {row.last_message_at === null ? '—' : moment(row.last_message_at)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {list.data !== undefined && list.data.total > PAGE && (
          <PageNav offset={offset} limit={PAGE} total={list.data.total} onChange={setOffset} />
        )}
        {list.data !== undefined && (
          <p className="text-muted-foreground">
            {String(list.data.total)}{' '}
            {plural(list.data.total, ['подписчик', 'подписчика', 'подписчиков'])} всего, вместе с
            остановившими
          </p>
        )}
      </section>
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card p-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={`num text-xl font-semibold ${tone ?? ''}`}>{value}</span>
      {note !== undefined && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

/** Воронка полосами: ширина — доля от первого шага, рядом число и доля. */
function Funnel({ steps }: { steps: readonly (readonly [string, number])[] }) {
  const top = steps[0]?.[1] ?? 0;
  return (
    <div className="flex flex-col gap-1.5">
      {steps.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[150px_1fr_90px] items-center gap-2">
          <span className="text-muted-foreground">{label}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-border">
            <span
              className="block h-full rounded-full bg-primary"
              style={{ width: top === 0 ? '0%' : `${String(Math.round((value * 100) / top))}%` }}
            />
          </span>
          <span className="num text-right">
            {String(value)} · {share(value, top)}
          </span>
        </div>
      ))}
    </div>
  );
}
