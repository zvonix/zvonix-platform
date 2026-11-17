'use client';

import { useQuery } from '@tanstack/react-query';
import type { NodeStatus } from '@zvonix/shared';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { LineChart, type ChartPoint } from '@/components/line-chart';
import { PeriodPicker } from '@/components/period-picker';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { gaugeTone, usedPercent } from '@/lib/gauge';
import { NODE_STATUS_NAME, nodeTone } from '@/lib/labels';
import { periodKey, periodMoments, periodQuery, type ReportPeriod } from '@/lib/reports';

type Range = 'hour' | 'day' | 'week';

/**
 * Быстрые окна графиков: `days` — длина в сутках (час — доля суток), как у кнопок выбора периода;
 * свой период — календарём, тем же, что у отчётов (ADR-0059, ревизия 2026-11-17).
 */
const RANGES: readonly { value: Range; days: number; label: string; ms: number; stepMs: number }[] =
  [
    { value: 'hour', days: 1 / 24, label: 'Час', ms: 3_600_000, stepMs: 60_000 },
    { value: 'day', days: 1, label: 'Сутки', ms: 86_400_000, stepMs: 300_000 },
    { value: 'week', days: 7, label: 'Неделя', ms: 604_800_000, stepMs: 1_800_000 },
  ];

/** Свой период: корзина шире, чтобы точек было не больше ~700 — как считает API. */
const customStep = (spanMs: number): number =>
  Math.max(1, Math.ceil(spanMs / 700 / 60_000)) * 60_000;

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
  const [period, setPeriod] = useState<ReportPeriod>({ days: 1 });
  const preset = 'days' in period ? RANGES.find((item) => item.days === period.days) : undefined;
  const bounds = preset === undefined ? periodMoments(period) : undefined;
  const custom =
    bounds === undefined ? undefined : { from: Date.parse(bounds.from), to: Date.parse(bounds.to) };

  const servers = useQuery({
    queryKey: ['servers', periodKey(period)],
    queryFn: ({ signal }) =>
      request<{ servers: Server[] }>(
        preset === undefined ? `/servers?${periodQuery(period)}` : `/servers?range=${preset.value}`,
        { signal },
      ),
    // Замеры идут раз в минуту: чаще спрашивать нечего.
    refetchInterval: 60_000,
  });

  const error = servers.error instanceof ApiError ? servers.error : undefined;

  return (
    <div className="flex flex-col gap-4">
      <PeriodPicker
        value={period}
        onChange={setPeriod}
        presets={RANGES.map((item) => ({ days: item.days, label: item.label }))}
      />

      {error !== undefined && <ErrorNote error={error} />}
      {servers.isPending && <p className="text-muted-foreground">Загружаем…</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        {servers.data?.servers.map((server) => (
          <ServerCard
            key={server.id ?? 'platform'}
            server={server}
            from={custom?.from ?? servers.dataUpdatedAt - (preset?.ms ?? 86_400_000)}
            to={custom?.to ?? servers.dataUpdatedAt}
            stepMs={
              custom === undefined
                ? (preset?.stepMs ?? 300_000)
                : customStep(custom.to - custom.from)
            }
          />
        ))}
      </div>
    </div>
  );
}

function ServerCard({
  server,
  from,
  to,
  stepMs,
}: {
  server: Server;
  /** Окно графиков, мс от начала эпохи. */
  from: number;
  to: number;
  stepMs: number;
}) {
  const { current } = server;
  const windowMs = to - from;
  const syncId = `server-${server.id ?? 'platform'}`;

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
              from={from}
              to={to}
              stepMs={stepMs}
              label={`${server.name}: загрузка процессора, %`}
              formatTime={formatTime}
              syncId={syncId}
            />
            <LineChart
              title="Память"
              points={memory}
              from={from}
              to={to}
              stepMs={stepMs}
              label={`${server.name}: занятая память, %`}
              formatTime={formatTime}
              syncId={syncId}
            />
            <LineChart
              title="Диск"
              points={disk}
              from={from}
              to={to}
              stepMs={stepMs}
              label={`${server.name}: занятое место на диске, %`}
              formatTime={formatTime}
              syncId={syncId}
            />
          </div>

          <details>
            <summary className="cursor-pointer text-muted-foreground">Показать таблицей</summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="num w-full text-left whitespace-nowrap">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                  <tr>
                    <th className="h-8 pr-3 font-normal">Время</th>
                    <th className="h-8 pr-3 text-right font-normal">Процессор</th>
                    <th className="h-8 pr-3 text-right font-normal">Память</th>
                    <th className="h-8 text-right font-normal">Диск</th>
                  </tr>
                </thead>
                <tbody>
                  {[...server.series].reverse().map((point) => (
                    <tr key={point.at} className="border-t border-border-soft">
                      <td className="py-1 pr-3 text-muted-foreground">
                        {formatTime(Date.parse(point.at))}
                      </td>
                      <td className="pr-3 text-right">
                        {String(usedPercent(point.load1, current.cpu_cores))} %
                      </td>
                      <td className="pr-3 text-right">
                        {String(
                          usedPercent(
                            current.mem_total_mb - point.mem_available_mb,
                            current.mem_total_mb,
                          ),
                        )}{' '}
                        %
                      </td>
                      <td className="text-right">
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
