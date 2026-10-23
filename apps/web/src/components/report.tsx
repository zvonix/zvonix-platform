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
import { money, sumMoney } from '@/lib/money';
import {
  acd,
  asNumber,
  asr,
  deliveredShare,
  readShare,
  REPORT_PERIODS,
  useBreakdown,
  useOverview,
  type MoneyKey,
  type ReportProduct,
  type ReportRow,
} from '@/lib/reports';

/** Что показывает сводка данной роли (ADR-0059). */
export interface ReportConfig {
  /** Начало пути API: `/reports`, `/client/reports`, `/partner/reports`. */
  readonly base: string;
  /**
   * Денежные показатели в порядке слева направо: `key` — за вызовы, `messageKey` — то же за сообщения MAX; первый рисуется
   * на графике по умолчанию.
   */
  readonly money: readonly {
    readonly key: MoneyKey;
    readonly messageKey: MoneyKey;
    readonly label: string;
  }[];
  readonly dimensions: readonly {
    readonly by: string;
    readonly label: string;
    readonly product: ReportProduct;
  }[];
  /** Подпись платы за бота в «Итого»; нет — роли она не положена (партнёр). */
  readonly botFeeLabel?: string;
}

/** Ключи разрезов сообщений словами: маршрут и откуда отправлено приходят значением перечисления. */
const MESSAGE_KEY_NAME: Record<string, string> = {
  account: 'Аккаунты партнёров',
  bot: 'Бот',
  api: 'API и кабинет',
  smpp: 'SMPP',
};

const PRODUCTS: readonly { readonly key: ReportProduct; readonly label: string }[] = [
  { key: 'calls', label: 'Звонки' },
  { key: 'messages', label: 'Сообщения MAX' },
];

const percent = (value: number | undefined): string =>
  value === undefined ? '—' : `${value.toFixed(1).replace('.', ',')} %`;

const talk = (seconds: number | undefined): string =>
  seconds === undefined ? '—' : duration(seconds);

/** Заголовок таблицы выгрузки: те же столбцы, что на экране, суммы — по роли. */
const tableHeader = (config: ReportConfig, product: ReportProduct): string[] =>
  product === 'calls'
    ? [
        'Вызовов',
        'Состоялось',
        'Доля состоявшихся, %',
        'Секунд разговора',
        ...config.money.map((entry) => entry.label),
      ]
    : [
        'Сообщений',
        'Доставлено',
        'Доля доставленных, %',
        'Прочитано',
        ...config.money.map((entry) => entry.label),
      ];

/** Дробная часть через запятую: так Excel русской настройки читает число, а не дату. */
const comma = (value: string): string => value.replace('.', ',');

function tableCells(
  config: ReportConfig,
  product: ReportProduct,
  row: ReportRow,
): (string | number)[] {
  if (product === 'messages') {
    const share = deliveredShare(row);
    return [
      row.messages,
      row.messages_delivered,
      share === undefined ? '' : comma(share.toFixed(1)),
      row.messages_read,
      ...config.money.map((entry) => comma(row[entry.messageKey] ?? '0')),
    ];
  }
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
  // Продукт: сводка была только по вызовам, MAX в ней не было вовсе (владелец, 2026-10-23).
  const [product, setProduct] = useState<ReportProduct>('calls');
  const [metric, setMetric] = useState<'count' | 'money'>('money');
  const dimensions = config.dimensions.filter((entry) => entry.product === product);
  const [by, setBy] = useState<string>(dimensions[0]?.by ?? '');

  const overview = useOverview(config.base, days);
  const breakdown = useBreakdown(config.base, days, by);

  const messages = product === 'messages';
  const dimensionLabel = dimensions.find((entry) => entry.by === by)?.label ?? 'Кто';
  const moneyOf = (entry: ReportConfig['money'][number]): MoneyKey =>
    messages ? entry.messageKey : entry.key;
  const firstMoney = config.money[0];
  const countLabel = messages ? 'Сообщения' : 'Вызовы';

  const chooseProduct = (next: ReportProduct): void => {
    setProduct(next);
    setBy(config.dimensions.find((entry) => entry.product === next)?.by ?? '');
  };

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
        <div
          className="flex flex-wrap gap-0.5 rounded-md border border-border bg-muted p-0.5"
          role="group"
          aria-label="Что считать"
        >
          {PRODUCTS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              aria-pressed={product === entry.key}
              onClick={() => {
                chooseProduct(entry.key);
              }}
              className={`rounded px-2.5 py-1.5 ${product === entry.key ? 'bg-card font-semibold shadow-[0_0_0_1px_var(--border)]' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <ExportButton
            name={messages ? 'сводка-max-по-дням' : 'сводка-по-дням'}
            load={() => {
              const data = overview.data;
              if (data === undefined) return Promise.reject(new Error('Сводка ещё не загружена'));
              return Promise.resolve({
                header: ['Сутки', ...tableHeader(config, product)],
                rows: data.series.map((row) => [row.day, ...tableCells(config, product, row)]),
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
          {/* «Итого» — оба продукта и плата за бота: сколько всего, не переключаясь. */}
          {firstMoney !== undefined && (
            <p className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
              <span>Итого за период, {firstMoney.label.toLowerCase()}:</span>
              <span className="num text-[15px] font-semibold text-foreground">
                {money(
                  sumMoney(
                    overview.data.totals[firstMoney.key],
                    overview.data.totals[firstMoney.messageKey],
                    config.botFeeLabel === undefined ? undefined : overview.data.bot_fees,
                  ),
                )}
              </span>
              <span className="num">
                звонки {money(overview.data.totals[firstMoney.key] ?? '0')} · MAX{' '}
                {money(overview.data.totals[firstMoney.messageKey] ?? '0')}
                {config.botFeeLabel !== undefined &&
                  ` · ${config.botFeeLabel} ${money(overview.data.bot_fees ?? '0')}`}
              </span>
            </p>
          )}

          {/* Столько колонок, сколько влезает: шесть карточек администратора — в один ряд, четыре
              клиентские — тоже, на телефоне — по две. Без «сирот» во втором ряду. */}
          <dl
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}
          >
            {messages ? (
              <>
                <Card title="Сообщений" value={String(overview.data.totals.messages)} />
                <Card
                  title="Доставлено"
                  value={String(overview.data.totals.messages_delivered)}
                  note={`доля ${percent(deliveredShare(overview.data.totals))}`}
                />
                <Card
                  title="Прочитано"
                  value={String(overview.data.totals.messages_read)}
                  note={`из доставленных ${percent(readShare(overview.data.totals))}`}
                />
              </>
            ) : (
              <>
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
              </>
            )}
            {config.money.map((entry) => (
              <Card
                key={entry.key}
                title={entry.label}
                value={money(overview.data.totals[moneyOf(entry)] ?? '0')}
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
                {(
                  [
                    { key: 'count', label: countLabel },
                    { key: 'money', label: firstMoney?.label ?? 'Деньги' },
                  ] as const
                ).map((entry) => (
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
            {(messages ? overview.data.totals.messages : overview.data.totals.calls) === 0 ? (
              <p className="py-6 text-muted-foreground">
                {messages ? 'За этот период сообщений не было.' : 'За этот период вызовов не было.'}
              </p>
            ) : (
              <Chart
                series={overview.data.series}
                product={product}
                moneyKey={
                  metric === 'money' && firstMoney !== undefined ? moneyOf(firstMoney) : undefined
                }
                label={metric === 'count' ? countLabel : (firstMoney?.label ?? '')}
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
            {dimensions.map((dimension) => (
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
                  header: [label, ...tableHeader(config, product)],
                  rows: data.rows.map((row) => [
                    nameOf(row) ?? 'не определено',
                    ...tableCells(config, product, row),
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
                {messages ? (
                  <>
                    <TableHead className="h-8 text-right">Сообщений</TableHead>
                    <TableHead className="h-8 text-right">Доставлено</TableHead>
                    <TableHead className="h-8 text-right">Прочитано</TableHead>
                  </>
                ) : (
                  <>
                    <TableHead className="h-8 text-right">Вызовов</TableHead>
                    <TableHead className="h-8 text-right">Доля состоявшихся</TableHead>
                    <TableHead className="h-8 text-right">Разговоров</TableHead>
                  </>
                )}
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
                    {messages
                      ? 'За этот период сообщений не было.'
                      : 'За этот период вызовов не было.'}
                  </TableCell>
                </TableRow>
              )}
              {breakdown.data?.rows.map((row) => (
                <TableRow key={row.key ?? 'none'}>
                  <TableCell>
                    {nameOf(row) ?? <span className="text-faint">не определено</span>}
                  </TableCell>
                  {messages ? (
                    <>
                      <TableCell className="num text-right">{row.messages}</TableCell>
                      <TableCell className="num text-right">
                        {row.messages_delivered} · {percent(deliveredShare(row))}
                      </TableCell>
                      <TableCell className="num text-right">
                        {row.messages_read} · {percent(readShare(row))}
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className="num text-right">{row.calls}</TableCell>
                      <TableCell className="num text-right">{percent(asr(row))}</TableCell>
                      <TableCell className="num text-right">{talk(row.talk_seconds)}</TableCell>
                    </>
                  )}
                  {config.money.map((entry) => (
                    <TableCell key={entry.key} className="num text-right">
                      {money(row[moneyOf(entry)] ?? '0')}
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

/** Название строки разреза: у маршрута и «откуда» — словами. */
const nameOf = (row: {
  readonly key: string | null;
  readonly name: string | null;
}): string | null => (row.name === null ? null : (MESSAGE_KEY_NAME[row.name] ?? row.name));

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
  product,
  moneyKey,
  label,
}: {
  series: readonly (ReportRow & { readonly day: string })[];
  product: ReportProduct;
  /** Деньги по этому ключу; нет — число вызовов или сообщений. */
  moneyKey: MoneyKey | undefined;
  label: string;
}) {
  const count = (row: ReportRow): number => (product === 'messages' ? row.messages : row.calls);
  const valueOf = (row: ReportRow): number =>
    moneyKey === undefined ? count(row) : asNumber(row[moneyKey]);
  const shown = (row: ReportRow): string =>
    moneyKey === undefined
      ? `${String(count(row))} ${plural(
          count(row),
          product === 'messages'
            ? ['сообщение', 'сообщения', 'сообщений']
            : ['вызов', 'вызова', 'вызовов'],
        )}`
      : money(row[moneyKey] ?? '0');
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
