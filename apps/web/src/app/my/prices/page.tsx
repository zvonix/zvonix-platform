'use client';

import { useQuery } from '@tanstack/react-query';
import type { TerminationKind } from '@zvonix/shared';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { SectionTabs, type SectionTab } from '@/components/section-tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';
import { useOperators } from '@/lib/dictionaries';
import { TERMINATION_KIND_MEANING, TERMINATION_KIND_NAME } from '@/lib/labels';
import { money } from '@/lib/money';

const COLUMNS = 6;

interface Tariff {
  readonly alias_id: string;
  readonly display_name: string;
  readonly termination_kind: TerminationKind;
  readonly operator_id: string;
  readonly region: string | null;
  readonly billing_increment_seconds: number;
  readonly minimum_duration_seconds: number;
  readonly price_per_minute: string;
  readonly connection_fee: string;
  readonly examples: readonly { seconds: number; amount: string }[];
}

export default function MyPricesPage() {
  return (
    <ConsoleShell title="Мои цены" cabinet="client">
      {() => <CallsAndMessages />}
    </ConsoleShell>
  );
}

/** «Звонки» и «Сообщения MAX» — вкладками; вторая есть, только если сообщения включены на площадке. */
function CallsAndMessages() {
  const price = useQuery({
    // Тот же ключ, что у страницы отправки: один запрос на обе.
    queryKey: ['client', 'messages', 'price'],
    queryFn: ({ signal }) =>
      request<{ enabled: boolean; price: string | null }>('/client/messages/price', { signal }),
  });
  const tabs: SectionTab[] = [{ id: 'calls', label: 'Звонки', content: <MyPrices /> }];
  if (price.data?.enabled === true) {
    tabs.push({
      id: 'max',
      label: 'Сообщения MAX',
      content: (
        <p className="rounded-lg border border-border bg-card p-4">
          {price.data.price === null
            ? 'Цена сообщения пока не задана: отправка недоступна.'
            : `Одно сообщение — ${money(price.data.price)}. Наценка площадки уже внутри. Не доставленное из-за отсутствия MAX у получателя возвращается на счёт.`}
        </p>
      ),
    });
  }
  return <SectionTabs tabs={tabs} />;
}

function MyPrices() {
  const operators = useOperators();
  const [operatorId, setOperatorId] = useState('');

  const list = useQuery({
    queryKey: ['my', 'tariffs', operatorId],
    queryFn: () =>
      request<{ tariffs: Tariff[] }>(
        operatorId === '' ? '/client/tariffs' : `/client/tariffs?operatorId=${operatorId}`,
      ),
  });

  const rows = list.data?.tariffs ?? [];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">
        Всё, что здесь показано, — <b>ваши</b> цены: наценка площадки уже внутри. Цена вызова
        складывается из платы за соединение и оплаты времени. Время считается не как есть, а шагами:
        при шаге в минуту разговор в 10 секунд оплачивается как полная минута, при посекундном — как
        10 секунд.
      </p>

      <p className="text-muted-foreground">
        Поэтому сравнивать предложения по одной лишь цене минуты нельзя: два тарифа по 2 ₽ за
        минуту, посекундный и поминутный, на вызове в минуту стоят одинаково, а на вызове в 20
        секунд отличаются втрое. Столбцы справа показывают, во что обойдётся вызов такой
        длительности целиком.
      </p>

      <label className="flex w-[280px] flex-col gap-1">
        <span className="text-muted-foreground">Оператор</span>
        <select
          value={operatorId}
          onChange={(event) => {
            setOperatorId(event.target.value);
          }}
          className="h-9 rounded-md border border-input bg-transparent px-2"
        >
          <option value="">все</option>
          {operators.rows.map((operator) => (
            <option key={operator.id} value={operator.id}>
              {operator.name}
            </option>
          ))}
        </select>
      </label>

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Предложение</TableHead>
              <TableHead className="h-8">Направление</TableHead>
              <TableHead className="h-8">Как считается время</TableHead>
              <TableHead className="h-8 text-right">За соединение</TableHead>
              <TableHead className="h-8 text-right">За минуту</TableHead>
              <TableHead className="h-8 text-right">Вызов 15 / 30 / 60 с</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {rows.length === 0 && !list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="whitespace-normal text-muted-foreground">
                  По этому отбору цен нет. Вызовы по направлениям, где цена не задана, не проходят —
                  площадке нечем их посчитать.
                </TableCell>
              </TableRow>
            )}

            {rows.map((row) => (
              <TableRow
                key={`${row.alias_id}:${row.termination_kind}:${row.operator_id}:${row.region ?? ''}`}
              >
                <TableCell>
                  {row.display_name}
                  <span
                    className="block text-faint"
                    title={TERMINATION_KIND_MEANING[row.termination_kind]}
                  >
                    {TERMINATION_KIND_NAME[row.termination_kind]}
                  </span>
                </TableCell>

                <TableCell>
                  {operators.nameOf(row.operator_id) ?? (
                    <span className="num text-faint">{row.operator_id}</span>
                  )}
                  <span className="block text-faint">{row.region ?? 'любой регион'}</span>
                </TableCell>

                <TableCell className="whitespace-normal">{billing(row)}</TableCell>

                <TableCell className="num text-right">{money(row.connection_fee)}</TableCell>
                <TableCell className="num text-right">{money(row.price_per_minute)}</TableCell>

                <TableCell className="num text-right">
                  {row.examples.map((example) => money(example.amount)).join(' / ')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * Шаг тарификации словами.
 *
 * «Шаг 60 секунд» — наш язык, а не язык клиента. Ему нужно понимать, что разговор
 * в десять секунд оплачивается как минута, и лучше прочитать это, чем вывести.
 */
function billing(row: Tariff): string {
  const step =
    row.billing_increment_seconds === 1
      ? 'посекундно'
      : row.billing_increment_seconds === 60
        ? 'поминутно'
        : `шагами по ${String(row.billing_increment_seconds)} с`;

  if (row.minimum_duration_seconds === 0) return step;
  return `${step}, но не меньше ${String(row.minimum_duration_seconds)} с`;
}
