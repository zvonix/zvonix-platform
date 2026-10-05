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
}: {
  href: string;
  label: string;
  value: string;
  /** Изменение к предыдущим суткам; для долей — в процентных пунктах. */
  delta: number | undefined;
  points?: boolean;
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
            : delta > 0
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
