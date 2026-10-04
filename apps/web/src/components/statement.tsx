'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { ExportButton } from '@/components/export-button';
import { Button } from '@/components/ui/button';
import { ApiError, request } from '@/lib/api';
import { duration } from '@/lib/format';
import { money } from '@/lib/money';

interface Metrics {
  readonly calls: number;
  readonly answered: number;
  readonly talk_seconds: number;
  /** Клиенту — потрачено, партнёру — начислено: приходит ровно одно из двух. */
  readonly spent?: string;
  readonly earned?: string;
}

type MoneyKey = 'spent' | 'earned';

const amountOf = (row: Metrics, key: MoneyKey): string => row[key] ?? '0';

interface Group extends Metrics {
  readonly name: string | null;
}

interface StatementData {
  readonly month: string;
  readonly from: string;
  readonly to: string;
  readonly partial: boolean;
  readonly totals: Metrics;
  readonly series: readonly (Metrics & { readonly day: string })[];
  readonly breakdowns: Readonly<Partial<Record<string, readonly Group[]>>>;
  readonly opening_balance: string;
  readonly closing_balance: string;
  readonly charged: string;
  readonly movements: readonly {
    readonly at: string;
    readonly kind: string;
    readonly description: string;
    readonly amount: string;
  }[];
  readonly client?: { readonly name: string };
  readonly partner?: { readonly name: string };
}

export interface StatementConfig {
  /** Адрес обработчика: `/client/statement`. */
  readonly path: string;
  /** Чей документ: от этого зависит название и шапка. */
  readonly party: 'client' | 'partner';
  /** Ключ суммы в ответе: клиенту `spent`, партнёру `earned`. */
  readonly moneyKey: MoneyKey;
  readonly moneyLabel: string;
  /** Что за остаток на счёте: у клиента «Остаток», у партнёра «Причитается». */
  readonly balanceLabel: string;
  /** Подпись суммы списаний/начислений по проводкам. */
  readonly chargedLabel: string;
  readonly dimensions: readonly { readonly by: string; readonly label: string }[];
}

const KIND_NAME: Record<string, string> = {
  deposit: 'Пополнение',
  payout: 'Выплата',
  correction: 'Исправление',
};

const currentMonth = (): string => {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const monthTitle = (month: string): string => {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Date(year, number - 1, 1).toLocaleDateString('ru-RU', {
    month: 'long',
    year: 'numeric',
  });
};

const dateOf = (iso: string): string =>
  new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

/**
 * Акт клиента и выписка партнёра за календарный месяц
 * ([ADR-0069](../../../../docs/adr/0069-akt-i-vypiska-za-mesyac.md)): документ на экране,
 * печать браузера (в PDF или на бумагу) и выгрузка по суткам в CSV. Лист белый всегда: в тёмной
 * теме печать на бумагу с белым текстом была бы пустой.
 */
export function Statement({ config }: { config: StatementConfig }) {
  const [month, setMonth] = useState(currentMonth);
  // Часовой пояс браузера: месяц считается по местному времени человека, как у сводок.
  const offset = -new Date().getTimezoneOffset();

  const statement = useQuery({
    queryKey: ['statement', config.path, month, offset],
    queryFn: ({ signal }) =>
      request<StatementData>(`${config.path}?month=${month}&offset=${String(offset)}`, { signal }),
    enabled: /^\d{4}-\d{2}$/u.test(month),
  });

  const data = statement.data;
  const error = statement.error instanceof ApiError ? statement.error : undefined;
  const name = data?.client?.name ?? data?.partner?.name ?? '';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Месяц</span>
          <input
            type="month"
            className="h-9 rounded-md border border-border bg-card px-2"
            value={month}
            max={currentMonth()}
            min="2020-01"
            onChange={(event) => {
              setMonth(event.target.value);
            }}
          />
        </label>
        <Button
          variant="outline"
          onClick={() => {
            window.print();
          }}
          disabled={data === undefined}
        >
          Печать / PDF
        </Button>
        <ExportButton
          name={`${config.party === 'client' ? 'акт' : 'выписка'}-${month}`}
          load={() => {
            if (data === undefined) return Promise.reject(new Error('Документ ещё не загружен'));
            return Promise.resolve({
              header: ['Сутки', 'Вызовов', 'Состоялось', 'Минут разговора', config.moneyLabel],
              rows: data.series.map((row) => [
                row.day,
                row.calls,
                row.answered,
                duration(row.talk_seconds),
                amountOf(row, config.moneyKey),
              ]),
            });
          }}
        />
      </div>

      {error !== undefined && <ErrorNote error={error} />}
      {statement.isPending && <p className="text-muted-foreground">Загружаем…</p>}

      {data !== undefined && (
        <article
          className="flex max-w-3xl flex-col gap-5 rounded-lg border border-neutral-300 bg-white p-6 text-neutral-900 print:max-w-none print:border-0 print:p-0"
          aria-label={`${config.party === 'client' ? 'Акт' : 'Выписка'} за ${monthTitle(data.month)}`}
        >
          <header className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">
              {config.party === 'client' ? 'Акт об оказанных услугах' : 'Выписка по начислениям'} за{' '}
              {monthTitle(data.month)}
            </h2>
            <p className="text-neutral-600">
              {config.party === 'client' ? 'Клиент' : 'Партнёр'}: {name}
            </p>
            <p className="text-neutral-600">
              Период: {dateOf(data.from)} —{' '}
              {dateOf(new Date(Date.parse(data.to) - 1).toISOString())}
              {data.partial && ' (месяц не закончен: данные на сегодня)'}
            </p>
          </header>

          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Figure title="Вызовов" value={String(data.totals.calls)} />
            <Figure title="Состоялось" value={String(data.totals.answered)} />
            <Figure title="Минут разговора" value={duration(data.totals.talk_seconds)} />
            <Figure
              title={config.moneyLabel}
              value={money(amountOf(data.totals, config.moneyKey))}
            />
          </section>

          {data.totals.calls === 0 ? (
            <p className="text-neutral-600">За этот месяц вызовов не было.</p>
          ) : (
            <>
              <Block title="По суткам">
                <Rows
                  first="Сутки"
                  moneyLabel={config.moneyLabel}
                  moneyKey={config.moneyKey}
                  rows={data.series.map((row) => ({ ...row, name: row.day }))}
                />
              </Block>

              {config.dimensions.map((dimension) => (
                <Block key={dimension.by} title={dimension.label}>
                  <Rows
                    first={dimension.label}
                    moneyLabel={config.moneyLabel}
                    moneyKey={config.moneyKey}
                    rows={(data.breakdowns[dimension.by] ?? []).map((row) => ({
                      ...row,
                      name: row.name ?? 'не определено',
                    }))}
                  />
                </Block>
              ))}
            </>
          )}

          <Block title="Движение по счёту">
            <table className="w-full">
              <tbody>
                <tr>
                  <td className="py-1">{config.balanceLabel} на начало месяца</td>
                  <td className="num py-1 text-right">{money(data.opening_balance)}</td>
                </tr>
                {data.movements.map((row) => (
                  <tr key={`${row.at}-${row.description}-${row.amount}`}>
                    <td className="py-1">
                      <span className="text-neutral-600">{dateOf(row.at)}</span>{' '}
                      {KIND_NAME[row.kind] ?? row.kind}: {row.description}
                    </td>
                    <td className="num py-1 text-right">{money(row.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-1">{config.chargedLabel}</td>
                  <td className="num py-1 text-right">{money(data.charged)}</td>
                </tr>
                <tr className="border-t border-neutral-300 font-semibold">
                  <td className="py-1">
                    {config.balanceLabel} на {data.partial ? 'сегодня' : 'конец месяца'}
                  </td>
                  <td className="num py-1 text-right">{money(data.closing_balance)}</td>
                </tr>
              </tbody>
            </table>
            <p className="pt-2 text-neutral-600">
              Вызов, начавшийся в последние минуты месяца, входит в услуги этого месяца, а его
              списание — в следующий: поэтому «{config.chargedLabel.toLowerCase()}» может отличаться
              от суммы по вызовам.
            </p>
          </Block>
        </article>
      )}
    </div>
  );
}

function Figure({ title, value }: { title: string; value: string }) {
  return (
    <div>
      <div className="text-neutral-600">{title}</div>
      <div className="num text-[15px] font-semibold">{value}</div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1 break-inside-avoid">
      <h3 className="font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Rows({
  first,
  rows,
  moneyKey,
  moneyLabel,
}: {
  first: string;
  rows: readonly (Metrics & { readonly name: string })[];
  moneyKey: MoneyKey;
  moneyLabel: string;
}) {
  if (rows.length === 0) return <p className="text-neutral-600">Вызовов не было.</p>;
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-neutral-300 text-left text-neutral-600">
          <th className="py-1 font-normal">{first}</th>
          <th className="py-1 text-right font-normal">Вызовов</th>
          <th className="py-1 text-right font-normal">Состоялось</th>
          <th className="py-1 text-right font-normal">Минут</th>
          <th className="py-1 text-right font-normal">{moneyLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name} className="border-b border-neutral-200">
            <td className="py-1">{row.name}</td>
            <td className="num py-1 text-right">{row.calls}</td>
            <td className="num py-1 text-right">{row.answered}</td>
            <td className="num py-1 text-right">{duration(row.talk_seconds)}</td>
            <td className="num py-1 text-right">{money(amountOf(row, moneyKey))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
