'use client';

import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { NODE_OFFLINE_AFTER_MS, type NodeStatus } from '@zvonix/shared';
import { ConsoleShell } from '@/components/console-shell';
import type { ChartScope } from '@/components/day-chart';
import { DayChartCard } from '@/components/day-chart-card';
import { MoneyTotal } from '@/components/money-total';
import { PeriodPicker } from '@/components/period-picker';
import { request } from '@/lib/api';
import { duration } from '@/lib/format';
import { useLiveInterval } from '@/lib/live';
import { sumMoney } from '@/lib/money';
import { changeDirection, changeText, periodChange, type PeriodChange } from '@/lib/period-change';
import { gaugeTone, usedPercent } from '@/lib/gauge';
import { NODE_STATUS_NAME, nodeTone } from '@/lib/labels';
import {
  periodQuery,
  previousPeriod,
  useOverview,
  type ReportPeriod,
  type ReportRow,
} from '@/lib/reports';

/**
 * Сумма показателей за дни. Деньги — строкой API, сложенные точно: плитка показывает итог до копеек,
 * а в подсказке — точное значение, и оно должно быть точным, а не суммой чисел с плавающей точкой.
 */
function sum(rows: readonly ReportRow[]) {
  return rows.reduce(
    (total, row) => ({
      calls: total.calls + row.calls,
      answered: total.answered + row.answered,
      talk: total.talk + row.talk_seconds,
      // Деньги — звонки и MAX вместе: «Списано» и «Наш доход» считали одни вызовы (владелец, 2026-10-23).
      revenue: sumMoney(total.revenue, row.revenue, row.message_revenue),
      margin: sumMoney(total.margin, row.margin, row.message_margin),
    }),
    { calls: 0, answered: 0, talk: 0, revenue: '0', margin: '0' },
  );
}

/** Изменение суммы денег: для сравнения точности числа хватает, учёта здесь нет. */
const moneyChange = (now: string, before: string): PeriodChange =>
  periodChange(Number(now), Number(before));

/** Изменение доли в процентных пунктах; доли нет в одном из периодов — сравнивать не с чем. */
const pointsChange = (now: number | undefined, before: number | undefined): PeriodChange =>
  now === undefined || before === undefined
    ? { kind: 'unknown' }
    : { kind: 'percent', value: now - before };

/** Пока прошлый период не загружен, его нули — не «раньше не было», а «ещё не знаем». */
const knownIf = (loaded: boolean, change: PeriodChange): PeriodChange =>
  loaded ? change : { kind: 'unknown' };

export default function OverviewPage() {
  return (
    <ConsoleShell title="Обзор" requireRole={['admin', 'support']}>
      {() => <Overview />}
    </ConsoleShell>
  );
}

function Overview() {
  // Период показателей и графика; сравнение — с периодом той же длины прямо перед ним.
  const [period, setPeriod] = useState<ReportPeriod>({ days: 7 });
  const [scope, setScope] = useState<ChartScope>('all');
  const overview = useOverview('/reports', period);
  const earlier = useOverview('/reports', previousPeriod(period));
  const live = useLiveInterval();

  const applications = useQuery({
    queryKey: ['overview', 'applications'],
    queryFn: () => request<{ total: number }>('/applications?status=submitted&limit=1'),
    refetchInterval: live,
  });
  const payments = useQuery({
    queryKey: ['overview', 'payments'],
    queryFn: () => request<{ total: number }>('/payments?status=pending&limit=1'),
    refetchInterval: live,
  });
  const tickets = useQuery({
    queryKey: ['overview', 'tickets'],
    queryFn: () => request<{ total: number }>('/support/staff/tickets?status=open&limit=1'),
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

  const now = sum(overview.data?.series ?? []);
  const before = sum(earlier.data?.series ?? []);
  const known = (change: PeriodChange) => knownIf(earlier.data !== undefined, change);
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
      <PlatformProblems />

      <section aria-label="Требует внимания" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Attention
          href="/applications"
          label="Заявки на рассмотрении"
          count={applications.data?.total}
          calm="нет новых"
        />
        <Attention
          href="/support"
          label="Обращения ждут ответа"
          count={tickets.data?.total}
          calm="все отвечены"
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

      <section aria-label="Показатели за период" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-semibold">Показатели</h2>
          <PeriodPicker value={period} onChange={setPeriod} />
          <span className="text-muted-foreground">изменение — к такому же периоду перед ним</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Kpi
            href="/reports"
            label="Вызовов"
            value={String(now.calls)}
            delta={known(periodChange(now.calls, before.calls))}
          />
          <Kpi
            href="/reports"
            label="Доля состоявшихся"
            value={share === undefined ? '—' : `${share.toFixed(1).replace('.', ',')} %`}
            delta={known(pointsChange(share, shareBefore))}
            points
          />
          <Kpi
            href="/reports"
            label="Время разговоров"
            value={duration(now.talk)}
            delta={known(periodChange(now.talk, before.talk))}
          />
          <Kpi
            href="/reports"
            label="Списано с клиентов"
            value={<MoneyTotal value={now.revenue} inLink />}
            delta={known(moneyChange(now.revenue, before.revenue))}
          />
          <Kpi
            href="/reports"
            label="Наш доход"
            value={<MoneyTotal value={now.margin} inLink />}
            delta={known(moneyChange(now.margin, before.margin))}
          />
        </div>
      </section>

      {overview.data !== undefined && (
        <DayChartCard
          series={overview.data.series}
          totals={overview.data.totals}
          pair={{ key: 'revenue', messageKey: 'message_revenue', label: 'Списано с клиентов' }}
          scope={scope}
          onScope={setScope}
        />
      )}

      <MessagesBlock period={period} />

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
  value: ReactNode;
  /** Изменение к такому же периоду перед этим; для долей — в процентных пунктах. */
  delta: PeriodChange;
  points?: boolean;
  /** Рост — плохо (например, «не отправлено»): цвет меняется местами. */
  inverse?: boolean;
}) {
  const direction = changeDirection(delta);
  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="num text-xl font-semibold">{value}</span>
      <span
        className={`text-xs ${
          direction === 'none' || direction === 'flat'
            ? 'text-faint'
            : (direction === 'up') !== inverse
              ? 'text-ok'
              : 'text-crit'
        }`}
      >
        {changeText(delta, points)}
      </span>
    </Link>
  );
}

/** Счётчик дел: ноль — спокойно, больше нуля — предупреждение (узлы — тревога). */
/**
 * Поломки самой площадки: почта не отправляет, воркер молчит, сообщения MAX не уходят. Пока всё в порядке — строки нет:
 * о сломанной почте письмом не сообщить, поэтому это видно здесь и красной точкой в меню (ADR-0062).
 */
function PlatformProblems() {
  const live = useLiveInterval();
  const problems = useQuery({
    queryKey: ['platform', 'problems'],
    queryFn: () =>
      request<{ count: number; problems: { name: string; reason: string }[] }>(
        '/platform/problems',
      ),
    refetchInterval: live,
  });
  if (!problems.data || problems.data.count === 0) return null;
  return (
    <section
      aria-label="Сбои площадки"
      role="alert"
      className="flex flex-col gap-1 rounded-lg border border-crit bg-card p-3"
    >
      <h2 className="font-semibold text-crit">Сбой на площадке</h2>
      <ul className="flex flex-col gap-1">
        {problems.data.problems.map((problem) => (
          <li key={problem.name}>
            <span className="font-medium">{problem.name}</span> — {problem.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}

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
 * Сообщения MAX за тот же период, что и показатели выше, к такому же периоду перед ним; по дням они — на общем графике.
 * Блока нет, пока сообщений не было вовсе: пустые плитки у выключенного продукта только шумят.
 */
function MessagesBlock({ period }: { period: ReportPeriod }) {
  const live = useLiveInterval();
  const load = (which: ReportPeriod) => ({
    queryKey: ['overview', 'messages', periodQuery(which)],
    queryFn: () => request<{ series: MessagesDay[] }>(`/messages/overview?${periodQuery(which)}`),
    refetchInterval: live,
  });
  const current = useQuery(load(period));
  const earlier = useQuery(load(previousPeriod(period)));

  const series = current.data?.series ?? [];
  if (series.every((row) => row.messages === 0)) return null;

  const total = (rows: readonly MessagesDay[]) =>
    rows.reduce(
      (all, row) => ({
        messages: all.messages + row.messages,
        delivered: all.delivered + row.delivered,
        failed: all.failed + row.failed,
        revenue: sumMoney(all.revenue, row.revenue),
        margin: sumMoney(all.margin, row.margin),
      }),
      { messages: 0, delivered: 0, failed: 0, revenue: '0', margin: '0' },
    );
  const now = total(series);
  const before = total(earlier.data?.series ?? []);
  const known = (change: PeriodChange) => knownIf(earlier.data !== undefined, change);
  const delivery = now.messages === 0 ? undefined : (now.delivered / now.messages) * 100;
  const deliveryBefore =
    before.messages === 0 ? undefined : (before.delivered / before.messages) * 100;

  return (
    <section aria-label="Сообщения MAX" className="flex flex-col gap-2">
      <h2 className="font-semibold">Сообщения MAX за период</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi
          href="/messaging"
          label="Сообщений"
          value={String(now.messages)}
          delta={known(periodChange(now.messages, before.messages))}
        />
        <Kpi
          href="/messaging"
          label="Доставлено"
          value={delivery === undefined ? '—' : `${delivery.toFixed(1).replace('.', ',')} %`}
          delta={known(pointsChange(delivery, deliveryBefore))}
          points
        />
        <Kpi
          href="/messaging"
          label="Не отправлено"
          value={String(now.failed)}
          delta={known(periodChange(now.failed, before.failed))}
          inverse
        />
        <Kpi
          href="/messaging"
          label="Списано с клиентов"
          value={<MoneyTotal value={now.revenue} inLink />}
          delta={known(moneyChange(now.revenue, before.revenue))}
        />
        <Kpi
          href="/messaging"
          label="Наш доход"
          value={<MoneyTotal value={now.margin} inLink />}
          delta={known(moneyChange(now.margin, before.margin))}
        />
      </div>
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
