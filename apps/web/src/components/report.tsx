'use client';

import { useState } from 'react';
import { BarChart } from '@/components/bar-chart';
import { ExportButton } from '@/components/export-button';
import { LiveSwitch } from '@/components/live-switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { duration, plural } from '@/lib/format';
import { money } from '@/lib/money';
import {
  acd,
  asNumber,
  asr,
  REPORT_PERIODS,
  useBreakdown,
  useOverview,
  type MoneyKey,
  type ReportRow,
} from '@/lib/reports';

/** Что показывает сводка данной роли (ADR-0059). */
export interface ReportConfig {
  /** Начало пути API: `/reports`, `/client/reports`, `/partner/reports`. */
  readonly base: string;
  /** Денежные показатели в порядке слева направо; первый рисуется на графике по умолчанию. */
  readonly money: readonly { readonly key: MoneyKey; readonly label: string }[];
  readonly dimensions: readonly { readonly by: string; readonly label: string }[];
}

const percent = (value: number | undefined): string =>
  value === undefined ? '—' : `${value.toFixed(1).replace('.', ',')} %`;

const talk = (seconds: number | undefined): string =>
  seconds === undefined ? '—' : duration(seconds);

/** Заголовок таблицы выгрузки: те же столбцы, что на экране, суммы — по роли. */
const tableHeader = (config: ReportConfig): string[] => [
  'Вызовов',
  'Состоялось',
  'Доля состоявшихся, %',
  'Секунд разговора',
  ...config.money.map((entry) => entry.label),
];

/** Дробная часть через запятую: так Excel русской настройки читает число, а не дату. */
const comma = (value: string): string => value.replace('.', ',');

function tableCells(config: ReportConfig, row: ReportRow): (string | number)[] {
  const share = asr(row);
  return [
    row.calls,
    row.answered,
    share === undefined ? '' : comma(share.toFixed(1)),
    row.talk_seconds,
    ...config.money.map((entry) => comma(row[entry.key] ?? '0')),
  ];
}

/** Сутки `ГГГГ-ММ-ДД` → `дд.мм`. */
const shortDay = (day: string): string => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

/**
 * Сводка: период, карточки, график по суткам и таблица по разрезам.
 * Одна на все роли — у каждой свои суммы и разрезы (`ReportConfig`), расчёт общий.
 */
export function Report({ config }: { config: ReportConfig }) {
  const [days, setDays] = useState<number>(7);
  const [metric, setMetric] = useState<'calls' | MoneyKey>(config.money[0]?.key ?? 'calls');
  const [by, setBy] = useState<string>(config.dimensions[0]?.by ?? '');

  const overview = useOverview(config.base, days);
  const breakdown = useBreakdown(config.base, days, by);

  const dimensionLabel = config.dimensions.find((entry) => entry.by === by)?.label ?? 'Кто';

  const moneyLabel = (key: MoneyKey): string =>
    config.money.find((entry) => entry.key === key)?.label ?? '';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div
          className="flex flex-wrap gap-0.5 rounded-md border border-border bg-muted p-0.5"
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
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <ExportButton
            name="сводка-по-дням"
            load={() => {
              const data = overview.data;
              if (data === undefined) return Promise.reject(new Error('Сводка ещё не загружена'));
              return Promise.resolve({
                header: ['Сутки', ...tableHeader(config)],
                rows: data.series.map((row) => [row.day, ...tableCells(config, row)]),
              });
            }}
          />
          <LiveSwitch />
        </div>
      </div>

      {overview.error !== null && (
        <p role="alert" className="text-crit">
          {overview.error.message}
        </p>
      )}

      {overview.data === undefined ? (
        overview.error === null && <p className="text-muted-foreground">Загружаем…</p>
      ) : (
        <>
          {/* Столько колонок, сколько влезает: шесть карточек администратора — в один ряд, четыре
              клиентские — тоже, на телефоне — по две. Без «сирот» во втором ряду. */}
          <dl
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}
          >
            <Card title="Вызовов" value={String(overview.data.totals.calls)} />
            <Card
              title="Состоялось"
              value={String(overview.data.totals.answered)}
              note={`доля ${percent(asr(overview.data.totals))}`}
            />
            <Card
              title="Разговоров"
              value={talk(overview.data.totals.talk_seconds)}
              note={`средний ${talk(acd(overview.data.totals))}`}
            />
            {config.money.map((entry) => (
              <Card
                key={entry.key}
                title={entry.label}
                value={money(overview.data.totals[entry.key] ?? '0')}
                strong
              />
            ))}
          </dl>

          <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">По дням</h2>
              <div
                className="flex flex-wrap gap-0.5 rounded-md border border-border bg-muted p-0.5"
                role="group"
                aria-label="Показатель"
              >
                {[{ key: 'calls' as const, label: 'Вызовы' }, ...config.money].map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    aria-pressed={metric === entry.key}
                    onClick={() => {
                      setMetric(entry.key);
                    }}
                    className={`rounded px-2.5 py-1.5 ${metric === entry.key ? 'bg-card font-semibold shadow-[0_0_0_1px_var(--border)]' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>
            {overview.data.totals.calls === 0 ? (
              <p className="py-6 text-muted-foreground">За этот период вызовов не было.</p>
            ) : (
              <Chart
                series={overview.data.series}
                metric={metric}
                label={metric === 'calls' ? 'Вызовы' : moneyLabel(metric)}
              />
            )}
          </section>
        </>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Разрез</h2>
          <div
            className="flex flex-wrap gap-0.5 rounded-md border border-border bg-muted p-0.5"
            role="group"
            aria-label="Разрез"
          >
            {config.dimensions.map((dimension) => (
              <button
                key={dimension.by}
                type="button"
                aria-pressed={by === dimension.by}
                onClick={() => {
                  setBy(dimension.by);
                }}
                className={`rounded px-2.5 py-1.5 ${by === dimension.by ? 'bg-card font-semibold shadow-[0_0_0_1px_var(--border)]' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {dimension.label}
              </button>
            ))}
          </div>
          <div className="ml-auto">
            <ExportButton
              name={`сводка-${dimensionLabel.toLowerCase()}`}
              load={() => {
                const data = breakdown.data;
                if (data === undefined) return Promise.reject(new Error('Разрез ещё не загружен'));
                const label = dimensionLabel;
                return Promise.resolve({
                  header: [label, ...tableHeader(config)],
                  rows: data.rows.map((row) => [
                    row.name ?? 'не определено',
                    ...tableCells(config, row),
                  ]),
                });
              }}
            />
          </div>
        </div>

        {breakdown.error !== null && (
          <p role="alert" className="text-crit">
            {breakdown.error.message}
          </p>
        )}

        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="text-muted-foreground hover:bg-transparent">
                <TableHead className="h-8">Кто</TableHead>
                <TableHead className="h-8 text-right">Вызовов</TableHead>
                <TableHead className="h-8 text-right">Доля состоявшихся</TableHead>
                <TableHead className="h-8 text-right">Разговоров</TableHead>
                {config.money.map((entry) => (
                  <TableHead key={entry.key} className="h-8 text-right">
                    {entry.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {breakdown.isPending && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4 + config.money.length} className="text-muted-foreground">
                    Загружаем…
                  </TableCell>
                </TableRow>
              )}
              {breakdown.data?.rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4 + config.money.length} className="text-muted-foreground">
                    За этот период вызовов не было.
                  </TableCell>
                </TableRow>
              )}
              {breakdown.data?.rows.map((row) => (
                <TableRow key={row.key ?? 'none'}>
                  <TableCell>
                    {row.name ?? <span className="text-faint">не определено</span>}
                  </TableCell>
                  <TableCell className="num text-right">{row.calls}</TableCell>
                  <TableCell className="num text-right">{percent(asr(row))}</TableCell>
                  <TableCell className="num text-right">{talk(row.talk_seconds)}</TableCell>
                  {config.money.map((entry) => (
                    <TableCell key={entry.key} className="num text-right">
                      {money(row[entry.key] ?? '0')}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

function Card({
  title,
  value,
  note,
  strong,
}: {
  title: string;
  value: string;
  note?: string;
  strong?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <dt className="text-muted-foreground">{title}</dt>
      <dd className={`num ${strong === true ? 'text-[15px] font-semibold' : 'text-[15px]'}`}>
        {value}
      </dd>
      {note !== undefined && <dd className="text-muted-foreground">{note}</dd>}
    </div>
  );
}

function Chart({
  series,
  metric,
  label,
}: {
  series: readonly (ReportRow & { readonly day: string })[];
  metric: 'calls' | MoneyKey;
  label: string;
}) {
  const valueOf = (row: ReportRow): number =>
    metric === 'calls' ? row.calls : asNumber(row[metric]);
  const shown = (row: ReportRow): string =>
    metric === 'calls'
      ? `${String(row.calls)} ${plural(row.calls, ['вызов', 'вызова', 'вызовов'])}`
      : money(row[metric] ?? '0');
  let best: (typeof series)[number] | undefined;
  for (const row of series) {
    if (best === undefined || valueOf(row) > valueOf(best)) best = row;
  }

  return (
    <BarChart
      bars={series.map((row) => ({
        label: shortDay(row.day),
        value: valueOf(row),
        title: `${shortDay(row.day)}: ${shown(row)}`,
      }))}
      peak={
        best === undefined || valueOf(best) === 0
          ? `${label}: за период ничего нет`
          : `${label}, наибольшее — ${shown(best)}`
      }
      summary={`${label} по дням`}
    />
  );
}
