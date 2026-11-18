'use client';

import { useState } from 'react';
import { CHART_COLORS, DayChart, type ChartScope, type DayPoint } from '@/components/day-chart';
import { Segmented } from '@/components/segmented';
import { plural } from '@/lib/format';
import { money, sumMoney } from '@/lib/money';
import { asNumber, type MoneyKey, type ReportRow } from '@/lib/reports';

/** Деньги графика: за вызовы (`key`) и за сообщения (`messageKey`) — одним показателем. */
export interface MoneyPair {
  readonly key: MoneyKey;
  readonly messageKey: MoneyKey;
  readonly label: string;
}

export const SCOPES: readonly { readonly key: ChartScope; readonly label: string }[] = [
  { key: 'all', label: 'Всё' },
  { key: 'calls', label: 'Звонки' },
  { key: 'messages', label: 'Сообщения' },
];

const callsWord = (count: number): string =>
  `${String(count)} ${plural(count, ['вызов', 'вызова', 'вызовов'])}`;
const messagesWord = (count: number): string =>
  `${String(count)} ${plural(count, ['сообщение', 'сообщения', 'сообщений'])}`;

/** Ряды графика по режиму: оба продукта сложенными столбцами или один. */
const seriesOf = (scope: ChartScope) =>
  [
    ...(scope === 'messages' ? [] : [{ label: 'Звонки', color: CHART_COLORS.calls }]),
    ...(scope === 'calls' ? [] : [{ label: 'Сообщения', color: CHART_COLORS.messages }]),
  ] as const;

/** Сутки ряда сводки → точка графика: высоты числом, подписи — строкой API. */
function pointOf(
  row: ReportRow & { readonly day: string },
  pair: MoneyPair | undefined,
  scope: ChartScope,
): DayPoint {
  const calls =
    pair === undefined
      ? { value: row.calls, text: callsWord(row.calls), raw: undefined }
      : {
          value: asNumber(row[pair.key]),
          text: money(row[pair.key] ?? '0'),
          raw: row[pair.key] ?? '0',
        };
  const messages =
    pair === undefined
      ? { value: row.messages, text: messagesWord(row.messages), raw: undefined }
      : {
          value: asNumber(row[pair.messageKey]),
          text: money(row[pair.messageKey] ?? '0'),
          raw: row[pair.messageKey] ?? '0',
        };
  const parts = [
    ...(scope === 'messages' ? [] : [calls]),
    ...(scope === 'calls' ? [] : [messages]),
  ];
  return {
    day: row.day,
    values: parts.map((part) => part.value),
    texts: parts.map((part) => part.text),
    totalText:
      parts.length === 1
        ? (parts[0]?.text ?? '')
        : pair === undefined
          ? String(row.calls + row.messages)
          : money(sumMoney(calls.raw, messages.raw)),
  };
}

/**
 * Карточка «По дням»: показатель (деньги или количество), итог за период и столбцы по суткам
 * (ADR-0059, ревизия 2026-11-17). Одна на «Сводку» всех ролей и «Обзор»: график везде одинаковый.
 * «Всё / Звонки / Сообщения» задаёт либо экран (`scope`), либо сама карточка (`onScope`).
 */
export function DayChartCard({
  series,
  totals,
  pair,
  scope,
  onScope,
  extra,
  title = 'По дням',
}: {
  series: readonly (ReportRow & { readonly day: string })[];
  totals: ReportRow;
  /** Деньги на графике; нет — только количество. */
  pair: MoneyPair | undefined;
  scope: ChartScope;
  /** Есть — переключатель «Всё / Звонки / Сообщения» в шапке карточки. */
  onScope?: (scope: ChartScope) => void;
  /** Строка под итогом: например, плата за бота, которой нет в столбцах. */
  extra?: string | undefined;
  title?: string;
}) {
  const [metric, setMetric] = useState<'count' | 'money'>('money');
  const moneyShown = metric === 'money' ? pair : undefined;

  const scopeMoney = (entry: MoneyPair): string =>
    scope === 'all'
      ? sumMoney(totals[entry.key], totals[entry.messageKey])
      : (totals[scope === 'calls' ? entry.key : entry.messageKey] ?? '0');
  const empty =
    (scope === 'all'
      ? totals.calls + totals.messages
      : scope === 'calls'
        ? totals.calls
        : totals.messages) === 0;
  const total =
    moneyShown !== undefined
      ? money(scopeMoney(moneyShown))
      : scope === 'all'
        ? `${callsWord(totals.calls)} · ${messagesWord(totals.messages)}`
        : scope === 'calls'
          ? callsWord(totals.calls)
          : messagesWord(totals.messages);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="font-semibold">{title}</h2>
        {onScope !== undefined && (
          <Segmented label="Что считать" options={SCOPES} value={scope} onChange={onScope} />
        )}
        {pair !== undefined && (
          <Segmented
            label="Показатель"
            options={[
              { key: 'money', label: pair.label },
              { key: 'count', label: 'Количество' },
            ]}
            value={metric}
            onChange={setMetric}
          />
        )}
        <div className="ml-auto flex flex-col items-end">
          <span className="num text-[17px] leading-tight font-semibold">{total}</span>
          {moneyShown !== undefined && scope === 'all' && (
            <span className="num text-muted-foreground">
              звонки {money(totals[moneyShown.key] ?? '0')} · сообщения{' '}
              {money(totals[moneyShown.messageKey] ?? '0')}
            </span>
          )}
          {moneyShown !== undefined && extra !== undefined && scope !== 'calls' && (
            <span className="num text-muted-foreground">{extra}</span>
          )}
        </div>
      </div>
      {empty ? (
        <p className="py-6 text-muted-foreground">За этот период ничего не было.</p>
      ) : (
        <DayChart
          points={series.map((row) => pointOf(row, moneyShown, scope))}
          series={seriesOf(scope)}
          label={`${moneyShown?.label ?? 'Количество'} по дням`}
        />
      )}
    </section>
  );
}
