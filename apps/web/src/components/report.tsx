'use client';

import { useState } from 'react';
import { DayChart, type ChartScope, type DayPoint } from '@/components/day-chart';
import { ExportButton } from '@/components/export-button';
import { LiveSwitch } from '@/components/live-switch';
import { PeriodPicker } from '@/components/period-picker';
import { Segmented } from '@/components/segmented';
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
  useBreakdown,
  useOverview,
  type MoneyKey,
  type ReportPeriod,
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

const SCOPES: readonly { readonly key: ChartScope; readonly label: string }[] = [
  { key: 'all', label: 'Всё' },
  { key: 'calls', label: 'Звонки' },
  { key: 'messages', label: 'Сообщения' },
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

/** Сутки ряда сводки → точка графика: высота числом, подписи — строкой API. */
function pointOf(
  row: ReportRow & { readonly day: string },
  moneyEntry: ReportConfig['money'][number] | undefined,
): DayPoint {
  if (moneyEntry === undefined) {
    return {
      day: row.day,
      calls: row.calls,
      messages: row.messages,
      callsText: `${String(row.calls)} ${plural(row.calls, ['вызов', 'вызова', 'вызовов'])}`,
      messagesText: `${String(row.messages)} ${plural(row.messages, ['сообщение', 'сообщения', 'сообщений'])}`,
      totalText: String(row.calls + row.messages),
    };
  }
  const calls = row[moneyEntry.key] ?? '0';
  const messages = row[moneyEntry.messageKey] ?? '0';
  return {
    day: row.day,
    calls: asNumber(calls),
    messages: asNumber(messages),
    callsText: money(calls),
    messagesText: money(messages),
    totalText: money(sumMoney(calls, messages)),
  };
}

/**
 * Сводка: период, карточки, график по суткам и таблица по разрезам.
 * Одна на все роли — у каждой свои суммы и разрезы (`ReportConfig`), расчёт общий.
 *
 * «Всё / Звонки / Сообщения» (владелец, 2026-11-17: «общий график по заработку с переключением
 * отдельно на звонки и на сообщения») задаёт и карточки, и график, и список разрезов.
 */
export function Report({ config }: { config: ReportConfig }) {
  const [period, setPeriod] = useState<ReportPeriod>({ days: 7 });
  const [scope, setScope] = useState<ChartScope>('all');
  const [metric, setMetric] = useState<'count' | 'money'>('money');
  const dimensions =
    scope === 'all'
      ? config.dimensions
      : config.dimensions.filter((entry) => entry.product === scope);
  const [by, setBy] = useState<string>(config.dimensions[0]?.by ?? '');
  const dimension = dimensions.find((entry) => entry.by === by) ?? dimensions[0];
  const product: ReportProduct = dimension?.product ?? 'calls';

  const overview = useOverview(config.base, period);
  const breakdown = useBreakdown(config.base, period, dimension?.by ?? by);

  const messages = product === 'messages';
  const dimensionLabel = dimension?.label ?? 'Кто';
  const moneyOf = (entry: ReportConfig['money'][number]): MoneyKey =>
    messages ? entry.messageKey : entry.key;
  const firstMoney = config.money[0];
  const moneyEntry = metric === 'money' ? firstMoney : undefined;

  const chooseScope = (next: ChartScope): void => {
    setScope(next);
    if (next !== 'all' && !config.dimensions.some((d) => d.by === by && d.product === next)) {
      setBy(config.dimensions.find((entry) => entry.product === next)?.by ?? '');
    }
  };

  const totals = overview.data?.totals;
  const scopeMoney = (entry: ReportConfig['money'][number]): string =>
    totals === undefined
      ? '0'
      : scope === 'all'
        ? sumMoney(totals[entry.key], totals[entry.messageKey])
        : (totals[scope === 'calls' ? entry.key : entry.messageKey] ?? '0');
  const nothing =
    totals === undefined ||
    (scope === 'all'
      ? totals.calls + totals.messages
      : scope === 'calls'
        ? totals.calls
        : totals.messages) === 0;

  /** Итог графика за период — то же, что сумма столбцов. */
  const chartTotal = (): string => {
    if (totals === undefined) return '';
    if (moneyEntry !== undefined) return money(scopeMoney(moneyEntry));
    const calls = `${String(totals.calls)} ${plural(totals.calls, ['вызов', 'вызова', 'вызовов'])}`;
    const sent = `${String(totals.messages)} ${plural(totals.messages, ['сообщение', 'сообщения', 'сообщений'])}`;
    return scope === 'all' ? `${calls} · ${sent}` : scope === 'calls' ? calls : sent;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <PeriodPicker value={period} onChange={setPeriod} />
        <Segmented label="Что считать" options={SCOPES} value={scope} onChange={chooseScope} />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <ExportButton
            name="сводка-по-дням"
            load={() => {
              const data = overview.data;
              if (data === undefined) return Promise.reject(new Error('Сводка ещё не загружена'));
              return Promise.resolve({
                header: [
                  'Сутки',
                  ...tableHeader(config, 'calls'),
                  ...tableHeader(config, 'messages'),
                ],
                rows: data.series.map((row) => [
                  row.day,
                  ...tableCells(config, 'calls', row),
                  ...tableCells(config, 'messages', row),
                ]),
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
        <div
          className={`flex flex-col gap-4 transition-opacity ${overview.isPlaceholderData ? 'opacity-60' : ''}`}
        >
          {/* Столько колонок, сколько влезает: шесть карточек администратора — в один ряд, четыре
              клиентские — тоже, на телефоне — по две. Без «сирот» во втором ряду. */}
          <dl
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}
          >
            {config.money.map((entry) => (
              <Card key={entry.key} title={entry.label} value={money(scopeMoney(entry))} strong />
            ))}
            {/* Ровно три карточки счётчиков в любом режиме: вместе с деньгами (одна у клиента и партнёра,
                три у сотрудников) их чётное число — без одинокой карточки во втором ряду. */}
            {scope !== 'messages' && (
              <Card
                title="Вызовов"
                value={String(overview.data.totals.calls)}
                note={`состоялось ${percent(asr(overview.data.totals))}`}
              />
            )}
            {scope === 'calls' && (
              <Card title="Состоялось" value={String(overview.data.totals.answered)} />
            )}
            {scope !== 'calls' && (
              <Card
                title="Сообщений"
                value={String(overview.data.totals.messages)}
                note={`доставлено ${percent(deliveredShare(overview.data.totals))}`}
              />
            )}
            {scope === 'messages' && (
              <Card title="Доставлено" value={String(overview.data.totals.messages_delivered)} />
            )}
            {scope === 'messages' ? (
              <Card
                title="Прочитано"
                value={String(overview.data.totals.messages_read)}
                note={`из доставленных ${percent(readShare(overview.data.totals))}`}
              />
            ) : (
              <Card
                title="Разговоров"
                value={talk(overview.data.totals.talk_seconds)}
                note={`средний ${talk(acd(overview.data.totals))}`}
              />
            )}
          </dl>

          <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="font-semibold">По дням</h2>
              <Segmented
                label="Показатель"
                options={[
                  { key: 'money', label: firstMoney?.label ?? 'Деньги' },
                  { key: 'count', label: 'Количество' },
                ]}
                value={metric}
                onChange={setMetric}
              />
              <div className="ml-auto flex flex-col items-end">
                <span className="num text-[17px] font-semibold leading-tight">{chartTotal()}</span>
                {moneyEntry !== undefined && scope === 'all' && (
                  <span className="num text-muted-foreground">
                    звонки {money(overview.data.totals[moneyEntry.key] ?? '0')} · сообщения{' '}
                    {money(overview.data.totals[moneyEntry.messageKey] ?? '0')}
                  </span>
                )}
                {moneyEntry !== undefined &&
                  config.botFeeLabel !== undefined &&
                  scope !== 'calls' && (
                    <span className="num text-muted-foreground">
                      и {config.botFeeLabel} {money(overview.data.bot_fees ?? '0')}
                    </span>
                  )}
              </div>
            </div>
            {nothing ? (
              <p className="py-6 text-muted-foreground">За этот период ничего не было.</p>
            ) : (
              <DayChart
                points={overview.data.series.map((row) => pointOf(row, moneyEntry))}
                scope={scope}
                label={`${moneyEntry?.label ?? 'Количество'} по дням`}
              />
            )}
          </section>
        </div>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Разрез</h2>
          <Segmented
            label="Разрез"
            options={dimensions.map((entry) => ({ key: entry.by, label: entry.label }))}
            value={dimension?.by ?? null}
            onChange={setBy}
          />
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
