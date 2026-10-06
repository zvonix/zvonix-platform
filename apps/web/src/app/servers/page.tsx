'use client';

import { useQuery } from '@tanstack/react-query';
import type { NodeStatus } from '@zvonix/shared';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { LineChart, type ChartPoint } from '@/components/line-chart';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { gaugeTone, usedPercent } from '@/lib/gauge';
import { NODE_STATUS_NAME, nodeTone } from '@/lib/labels';

type Range = 'hour' | 'day' | 'week';

const RANGES: readonly { value: Range; label: string; ms: number; stepMs: number }[] = [
  { value: 'hour', label: 'Час', ms: 3_600_000, stepMs: 60_000 },
  { value: 'day', label: 'Сутки', ms: 86_400_000, stepMs: 300_000 },
  { value: 'week', label: 'Неделя', ms: 604_800_000, stepMs: 1_800_000 },
];

interface Server {
  readonly scope: 'platform' | 'node';
  readonly id: string | null;
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
    readonly taken_at: string;
  } | null;
  readonly series: readonly {
    readonly at: string;
    readonly load1: number;
    readonly mem_available_mb: number;
    readonly disk_free_mb: number;
  }[];
}

const NUMBER = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const gigabytes = (mb: number): string => `${NUMBER.format(mb / 1024)} ГБ`;
export default function ServersPage() {
  return (
    <ConsoleShell title="Серверы" requireRole={['admin', 'support']}>
      {() => <ServersView />}
    </ConsoleShell>
  );
}

function ServersView() {
  const [range, setRange] = useState<Range>('day');
  const window = RANGES.find((item) => item.value === range) ?? RANGES[1];

  const servers = useQuery({
    queryKey: ['servers', range],
    queryFn: ({ signal }) => request<{ servers: Server[] }>(`/servers?range=${range}`, { signal }),
    // Замеры идут раз в минуту: чаще спрашивать нечего.
    refetchInterval: 60_000,
  });

  const error = servers.error instanceof ApiError ? servers.error : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label="Период графиков" className="flex gap-1">
        {RANGES.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={range === item.value}
            onClick={() => {
              setRange(item.value);
            }}
            className={`min-h-8 rounded-md border px-3 ${
              range === item.value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card hover:bg-muted'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error !== undefined && <ErrorNote error={error} />}
      {servers.isPending && <p className="text-muted-foreground">Загружаем…</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        {servers.data?.servers.map((server) => (
          <ServerCard
            key={server.id ?? 'platform'}
            server={server}
            windowMs={window?.ms ?? 86_400_000}
            stepMs={window?.stepMs ?? 300_000}
            now={servers.dataUpdatedAt}
          />
        ))}
      </div>
    </div>
  );
}

function ServerCard({
  server,
  windowMs,
  stepMs,
  now,
}: {
  server: Server;
  windowMs: number;
  stepMs: number;
  now: number;
}) {
  const { current } = server;

  const series = (pick: (point: Server['series'][number]) => number): ChartPoint[] =>
    server.series.map((point) => ({ t: Date.parse(point.at), v: pick(point) }));

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{server.name}</h2>
        {server.status !== null && (
          <span className={`rounded-sm px-1.5 py-0.5 ${nodeTone(server.status)}`}>
            {NODE_STATUS_NAME[server.status]}
          </span>
        )}
        {current !== null && (
          <span className="ml-auto text-muted-foreground">
            замер {moment(current.taken_at)}
            {current.active_calls !== null && ` · звонков ${String(current.active_calls)}`}
          </span>
        )}
      </header>

      {current === null ? (
        <p className="text-muted-foreground">
          Замеров нет. Узел присылает их после обновления (zvonix-node-update).
        </p>
      ) : (
        <>
          {server.stale && (
            <p className="text-warn">Последний замер давний: источник перестал присылать данные.</p>
          )}
          <Gauge
            title="Процессор"
            used={usedPercent(current.load1, current.cpu_cores)}
            text={`нагрузка ${NUMBER.format(current.load1)} на ${String(current.cpu_cores)} яд.`}
          />
          <Gauge
            title="Память"
            used={usedPercent(
              current.mem_total_mb - current.mem_available_mb,
              current.mem_total_mb,
            )}
            text={`занято ${gigabytes(current.mem_total_mb - current.mem_available_mb)} из ${gigabytes(current.mem_total_mb)}`}
          />
          <Gauge
            title="Диск"
            used={usedPercent(current.disk_total_mb - current.disk_free_mb, current.disk_total_mb)}
            text={`свободно ${gigabytes(current.disk_free_mb)} из ${gigabytes(current.disk_total_mb)}`}
          />

          <div className="grid gap-3 sm:grid-cols-3">
            <Chart title="Нагрузка">
              <LineChart
                points={series((point) => point.load1)}
                from={now - windowMs}
                to={now}
                stepMs={stepMs}
                ceiling={Math.max(current.cpu_cores, ...server.series.map((point) => point.load1))}
                format={(value) => NUMBER.format(value)}
                label={`${server.name}: нагрузка процессора`}
              />
            </Chart>
            <Chart title="Свободная память">
              <LineChart
                points={series((point) => point.mem_available_mb)}
                from={now - windowMs}
                to={now}
                stepMs={stepMs}
                ceiling={current.mem_total_mb}
                format={gigabytes}
                label={`${server.name}: свободная память`}
              />
            </Chart>
            <Chart title="Свободный диск">
              <LineChart
                points={series((point) => point.disk_free_mb)}
                from={now - windowMs}
                to={now}
                stepMs={stepMs}
                ceiling={current.disk_total_mb}
                format={gigabytes}
                label={`${server.name}: свободное место на диске`}
              />
            </Chart>
          </div>
        </>
      )}
    </section>
  );
}

function Gauge({ title, used, text }: { title: string; used: number; text: string }) {
  const clamped = Math.min(100, Math.max(0, used));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span>{title}</span>
        <span className="num text-muted-foreground">
          {String(clamped)} % · {text}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
      >
        <div className={`h-full ${gaugeTone(clamped)}`} style={{ width: `${String(clamped)}%` }} />
      </div>
    </div>
  );
}

function Chart({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground">{title}</span>
      {children}
    </div>
  );
}
