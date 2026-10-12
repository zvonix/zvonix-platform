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

  const [hoverAt, setHoverAt] = useState<number | null>(null);

  // Все три графика в процентах занятого: шкала одна и читается без пересчёта.
  const percentSeries = (used: (point: Server['series'][number]) => number): ChartPoint[] =>
    server.series.map((point) => ({
      t: Date.parse(point.at),
      v: Math.min(100, used(point)),
    }));
  const cores = current?.cpu_cores ?? 1;
  const memTotal = current?.mem_total_mb ?? 0;
  const diskTotal = current?.disk_total_mb ?? 0;
  const cpu = percentSeries((point) => usedPercent(point.load1, cores));
  const memory = percentSeries((point) => usedPercent(memTotal - point.mem_available_mb, memTotal));
  const disk = percentSeries((point) => usedPercent(diskTotal - point.disk_free_mb, diskTotal));
  // За час хватает времени; за сутки и неделю добавляем дату, иначе концы оси выглядят одинаково.
  const formatTime = (t: number): string => {
    const date = new Date(t);
    const clock = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return windowMs <= 3_600_000
      ? clock
      : `${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${clock}`;
  };

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

          <div className="flex flex-col gap-3">
            <LineChart
              title="Процессор"
              points={cpu}
              from={now - windowMs}
              to={now}
              stepMs={stepMs}
              label={`${server.name}: загрузка процессора, %`}
              formatTime={formatTime}
              hoverAt={hoverAt}
              onHover={setHoverAt}
            />
            <LineChart
              title="Память"
              points={memory}
              from={now - windowMs}
              to={now}
              stepMs={stepMs}
              label={`${server.name}: занятая память, %`}
              formatTime={formatTime}
              hoverAt={hoverAt}
              onHover={setHoverAt}
            />
            <LineChart
              title="Диск"
              points={disk}
              from={now - windowMs}
              to={now}
              stepMs={stepMs}
              label={`${server.name}: занятое место на диске, %`}
              formatTime={formatTime}
              hoverAt={hoverAt}
              onHover={setHoverAt}
            />
          </div>

          <details>
            <summary className="cursor-pointer text-muted-foreground">Показать таблицей</summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="num w-full text-left">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-normal">Время</th>
                    <th className="py-1 pr-3 font-normal">Процессор</th>
                    <th className="py-1 pr-3 font-normal">Память</th>
                    <th className="py-1 font-normal">Диск</th>
                  </tr>
                </thead>
                <tbody>
                  {[...server.series].reverse().map((point) => (
                    <tr key={point.at} className="border-t border-border-soft">
                      <td className="py-1 pr-3 text-muted-foreground">
                        {formatTime(Date.parse(point.at))}
                      </td>
                      <td className="pr-3">
                        {String(usedPercent(point.load1, current.cpu_cores))} %
                      </td>
                      <td className="pr-3">
                        {String(
                          usedPercent(
                            current.mem_total_mb - point.mem_available_mb,
                            current.mem_total_mb,
                          ),
                        )}{' '}
                        %
                      </td>
                      <td>
                        {String(
                          usedPercent(
                            current.disk_total_mb - point.disk_free_mb,
                            current.disk_total_mb,
                          ),
                        )}{' '}
                        %
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
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
