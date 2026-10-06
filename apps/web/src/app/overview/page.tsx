'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { NODE_OFFLINE_AFTER_MS, type NodeStatus } from '@zvonix/shared';
import { BarChart } from '@/components/bar-chart';
import { ConsoleShell } from '@/components/console-shell';
import { request } from '@/lib/api';
import { duration, plural } from '@/lib/format';
import { useLiveInterval } from '@/lib/live';
import { money } from '@/lib/money';
import { gaugeTone, usedPercent } from '@/lib/gauge';
import { NODE_STATUS_NAME, nodeTone } from '@/lib/labels';
import { useOverview, type ReportRow } from '@/lib/reports';

/** Сколько суток сравниваем: последние со всеми предыдущими такой же длины. */
const SPAN = 7;

const shortDay = (day: string): string => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const asNumber = (value: string | undefined): number => Number(value ?? '0');

/** Сумма показателей за дни. Деньги — числом: нужны только для сравнения и подписи, не для учёта. */
function sum(rows: readonly ReportRow[]) {
  return rows.reduce(
    (total, row) => ({
      calls: total.calls + row.calls,
      answered: total.answered + row.answered,
      talk: total.talk + row.talk_seconds,
      revenue: total.revenue + asNumber(row.revenue),
      margin: total.margin + asNumber(row.margin),
    }),
    { calls: 0, answered: 0, talk: 0, revenue: 0, margin: 0 },
  );
}

/** Изменение к предыдущим суткам в процентах; `undefined`, когда сравнивать не с чем. */
function change(now: number, before: number): number | undefined {
  if (before === 0) return now === 0 ? 0 : undefined;
  return ((now - before) / before) * 100;
}

const rubles = (value: number): string => money(value.toFixed(2));

export default function OverviewPage() {
  return (
    <ConsoleShell title="Обзор" requireRole={['admin', 'support']}>
      {() => <Overview />}
    </ConsoleShell>
  );
}

function Overview() {
  const overview = useOverview('/reports', SPAN * 2);
  const live = useLiveInterval();

  const applications = useQuery({
    queryKey: ['overview', 'applications'],
    queryFn: () => request<{ total: number }>('/applications?status=pending&limit=1'),
    refetchInterval: live,
  });
  const payments = useQuery({
    queryKey: ['overview', 'payments'],
    queryFn: () => request<{ total: number }>('/payments?status=pending&limit=1'),
    refetchInterval: live,
  });
  const nodes = useQuery({
    queryKey: ['overview', 'nodes'],
    queryFn: () =>
      request<{
        nodes: { status: NodeStatus; last_heartbeat_at: string | null }[];
      }>('/nodes'),
    refetchInterval: live,
  });

  const series = overview.data?.series ?? [];
  const recent = series.slice(-SPAN);
  const previous = series.slice(-SPAN * 2, -SPAN);
  const now = sum(recent);
  const before = sum(previous);
  const share = now.calls === 0 ? undefined : (now.answered / now.calls) * 100;
  const shareBefore = before.calls === 0 ? undefined : (before.answered / before.calls) * 100;

  // Узел, который должен работать, но молчит: статус «offline» или давно не откликался.
  const silentNodes =
    nodes.data?.nodes.filter(
      (node) =>
        node.status === 'offline' ||
        node.status === 'degraded' ||
        (node.status === 'online' &&
          node.last_heartbeat_at !== null &&
          Date.now() - Date.parse(node.last_heartbeat_at) > NODE_OFFLINE_AFTER_MS),
    ).length ?? 0;

  return (
    <div className="flex max-w-[1100px] flex-col gap-5">
      <section aria-label="Требует внимания" className="grid gap-3 sm:grid-cols-3">
        <Attention
          href="/applications"
          label="Заявки на рассмотрении"
          count={applications.data?.total}
          calm="нет новых"
        />
        <Attention
          href="/payments"
          label="Платежи ждут решения"
          count={payments.data?.total}
          calm="всё разобрано"
        />
        <Attention
          href="/nodes"
          label="Узлы не в порядке"
          count={nodes.data === undefined ? undefined : silentNodes}
          calm="все на связи"
          critical
        />
      </section>

      <ServersBlock />

      <section aria-label={`Показатели за ${String(SPAN)} суток`} className="flex flex-col gap-2">
        <h2 className="font-semibold">Последние {String(SPAN)} суток</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Kpi
            href="/reports"
            label="Вызовов"
            value={String(now.calls)}
            delta={change(now.calls, before.calls)}
          />
          <Kpi
            href="/reports"
            label="Доля состоявшихся"
            value={share === undefined ? '—' : `${share.toFixed(1).replace('.', ',')} %`}
            delta={
              share === undefined || shareBefore === undefined ? undefined : share - shareBefore
            }
            points
          />
          <Kpi
            href="/reports"
            label="Время разговоров"
            value={duration(now.talk)}
            delta={change(now.talk, before.talk)}
          />
          <Kpi
            href="/reports"
            label="Списано с клиентов"
            value={rubles(now.revenue)}
            delta={change(now.revenue, before.revenue)}
          />
          <Kpi
            href="/reports"
            label="Наш доход"
            value={rubles(now.margin)}
            delta={change(now.margin, before.margin)}
          />
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">Вызовы по дням</h2>
          <BarChart
            bars={series.map((row) => ({
              label: shortDay(row.day),
              value: row.calls,
              title: `${shortDay(row.day)}: ${String(row.calls)} ${plural(row.calls, ['вызов', 'вызова', 'вызовов'])}`,
            }))}
            peak={`За ${String(SPAN * 2)} суток: ${String(now.calls + before.calls)} ${plural(now.calls + before.calls, ['вызов', 'вызова', 'вызовов'])}`}
            summary="Вызовы по дням"
          />
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">Списано с клиентов по дням</h2>
          <BarChart
            bars={series.map((row) => ({
              label: shortDay(row.day),
              value: asNumber(row.revenue),
              title: `${shortDay(row.day)}: ${money(row.revenue ?? '0')}`,
            }))}
            peak={`За ${String(SPAN * 2)} суток: ${rubles(now.revenue + before.revenue)}`}
            summary="Списано с клиентов по дням"
          />
        </section>
      </div>

      <MessagesBlock />

      <p className="text-muted-foreground">
        Подробнее — в{' '}
        <Link href="/reports" className="underline underline-offset-2 hover:text-foreground">
          сводке по разрезам
        </Link>
        : партнёры, операторы, линии, SIM, шлюзы.
      </p>
    </div>
  );
}

/** Число, которое раскрывается: ведёт на страницу, из которой оно посчитано. */
function Kpi({
  href,
  label,
  value,
  delta,
  points = false,
  inverse = false,
}: {
  href: string;
  label: string;
  value: string;
  /** Изменение к предыдущим суткам; для долей — в процентных пунктах. */
  delta: number | undefined;
  points?: boolean;
  /** Рост — плохо (например, «не отправлено»): цвет меняется местами. */
  inverse?: boolean;
}) {
  const sign = delta === undefined ? '' : delta > 0 ? '+' : '';
  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="num text-xl font-semibold">{value}</span>
      <span
        className={`text-xs ${
          delta === undefined || Math.abs(delta) < 0.05
            ? 'text-faint'
            : delta > 0 !== inverse
              ? 'text-ok'
              : 'text-crit'
        }`}
      >
        {delta === undefined
          ? 'нет данных для сравнения'
          : Math.abs(delta) < 0.05
            ? 'без изменений'
            : `${sign}${delta.toFixed(1).replace('.', ',')} ${points ? 'п. п.' : '%'} к прошлым ${String(SPAN)} суткам`}
      </span>
    </Link>
  );
}

/** Счётчик дел: ноль — спокойно, больше нуля — предупреждение (узлы — тревога). */
function Attention({
  href,
  label,
  count,
  calm,
  critical = false,
}: {
  href: string;
  label: string;
  count: number | undefined;
  calm: string;
  critical?: boolean;
}) {
  const busy = count !== undefined && count > 0;
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${
        busy ? (critical ? 'border-crit bg-card' : 'border-warn bg-card') : 'border-border bg-card'
      }`}
    >
      <span
        className={`num min-w-8 text-2xl font-semibold ${
          busy ? (critical ? 'text-crit' : 'text-warn') : 'text-ok'
        }`}
      >
        {count === undefined ? '…' : String(count)}
      </span>
      <span className="flex flex-col">
        <span>{label}</span>
        {count !== undefined && !busy && <span className="text-muted-foreground">{calm}</span>}
      </span>
    </Link>
  );
}

interface MessagesDay {
  readonly day: string;
  readonly messages: number;
  readonly delivered: number;
  readonly failed: number;
  readonly revenue: string;
  readonly margin: string;
}

/**
 * Сообщения MAX: те же 7 суток к предыдущим 7 и график по дням. Блока нет, пока сообщений не было вовсе:
 * пустые плитки у выключенного продукта только шумят.
 */
function MessagesBlock() {
  const live = useLiveInterval();
  const overview = useQuery({
    queryKey: ['overview', 'messages'],
    queryFn: () =>
      request<{ series: MessagesDay[] }>(
        `/messages/overview?days=${String(SPAN * 2)}&offset=${String(-new Date().getTimezoneOffset())}`,
      ),
    refetchInterval: live,
  });

  const series = overview.data?.series ?? [];
  if (series.every((row) => row.messages === 0)) return null;

  const total = (rows: readonly MessagesDay[]) =>
    rows.reduce(
      (all, row) => ({
        messages: all.messages + row.messages,
        delivered: all.delivered + row.delivered,
        failed: all.failed + row.failed,
        revenue: all.revenue + asNumber(row.revenue),
        margin: all.margin + asNumber(row.margin),
      }),
      { messages: 0, delivered: 0, failed: 0, revenue: 0, margin: 0 },
    );
  const now = total(series.slice(-SPAN));
  const before = total(series.slice(-SPAN * 2, -SPAN));
  const delivery = now.messages === 0 ? undefined : (now.delivered / now.messages) * 100;
  const deliveryBefore =
    before.messages === 0 ? undefined : (before.delivered / before.messages) * 100;

  return (
    <section aria-label="Сообщения MAX" className="flex flex-col gap-2">
      <h2 className="font-semibold">Сообщения MAX за {String(SPAN)} суток</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi
          href="/messaging"
          label="Сообщений"
          value={String(now.messages)}
          delta={change(now.messages, before.messages)}
        />
        <Kpi
          href="/messaging"
          label="Доставлено"
          value={delivery === undefined ? '—' : `${delivery.toFixed(1).replace('.', ',')} %`}
          delta={
            delivery === undefined || deliveryBefore === undefined
              ? undefined
              : delivery - deliveryBefore
          }
          points
        />
        <Kpi
          href="/messaging"
          label="Не отправлено"
          value={String(now.failed)}
          delta={change(now.failed, before.failed)}
          inverse
        />
        <Kpi
          href="/messaging"
          label="Списано с клиентов"
          value={rubles(now.revenue)}
          delta={change(now.revenue, before.revenue)}
        />
        <Kpi
          href="/messaging"
          label="Наш доход"
          value={rubles(now.margin)}
          delta={change(now.margin, before.margin)}
        />
      </div>
      <BarChart
        bars={series.map((row) => ({
          label: shortDay(row.day),
          value: row.messages,
          title: `${shortDay(row.day)}: ${String(row.messages)} ${plural(row.messages, ['сообщение', 'сообщения', 'сообщений'])}`,
        }))}
        peak={`За ${String(SPAN * 2)} суток: ${String(now.messages + before.messages)} ${plural(now.messages + before.messages, ['сообщение', 'сообщения', 'сообщений'])}`}
        summary="Сообщения по дням"
      />
    </section>
  );
}

interface ServerNow {
  readonly name: string;
  readonly status: NodeStatus | null;
  readonly stale: boolean;
  readonly current: {
    readonly load1: number;
    readonly cpu_cores: number;
    readonly mem_total_mb: number;
    readonly mem_available_mb: number;
    readonly disk_total_mb: number;
    readonly disk_free_mb: number;
    readonly active_calls: number | null;
  } | null;
}

/**
 * Серверы одним взглядом: у каждого процессор, память и диск полосками, состояние и звонки. Подробнее и с историей —
 * на странице «Серверы». Давний замер помечен: старое число выглядело бы живым.
 */
function ServersBlock() {
  const servers = useQuery({
    queryKey: ['overview', 'servers'],
    queryFn: ({ signal }) => request<{ servers: ServerNow[] }>('/servers?range=hour', { signal }),
    // Замеры идут раз в минуту.
    refetchInterval: 60_000,
  });
  const rows = servers.data?.servers ?? [];
  if (rows.length === 0) return null;

  return (
    <section aria-label="Серверы" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h2 className="font-semibold">Серверы</h2>
        <Link
          href="/servers"
          className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          история нагрузки
        </Link>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((server) => (
          <Link
            key={server.name}
            href="/servers"
            className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{server.name}</span>
              {server.status !== null && (
                <span className={`rounded-sm px-1.5 py-0.5 text-xs ${nodeTone(server.status)}`}>
                  {NODE_STATUS_NAME[server.status]}
                </span>
              )}
              {server.current?.active_calls !== null &&
                server.current?.active_calls !== undefined && (
                  <span className="num ml-auto text-muted-foreground">
                    звонков {String(server.current.active_calls)}
                  </span>
                )}
            </span>
            {server.current === null ? (
              <span className="text-muted-foreground">замеров нет</span>
            ) : (
              <>
                {server.stale && <span className="text-warn">замер давний</span>}
                <MiniGauge
                  label="Процессор"
                  used={usedPercent(server.current.load1, server.current.cpu_cores)}
                />
                <MiniGauge
                  label="Память"
                  used={usedPercent(
                    server.current.mem_total_mb - server.current.mem_available_mb,
                    server.current.mem_total_mb,
                  )}
                />
                <MiniGauge
                  label="Диск"
                  used={usedPercent(
                    server.current.disk_total_mb - server.current.disk_free_mb,
                    server.current.disk_total_mb,
                  )}
                />
              </>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}

/** Полоска заполненности: подпись, процент числом и цвет по порогам (75 % — внимание, 90 % — тревога). */
function MiniGauge({ label, used }: { label: string; used: number }) {
  const clamped = Math.min(100, used);
  return (
    <span className="grid grid-cols-[5.5rem_1fr_3rem] items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={`block h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${gaugeTone(clamped)}`}
          style={{ width: `${String(clamped)}%` }}
        />
      </span>
      <span className="num text-right">{String(used)} %</span>
    </span>
  );
}
