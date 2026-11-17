'use client';

import { useQuery } from '@tanstack/react-query';
import type { TerminationKind } from '@zvonix/shared';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { Hint } from '@/components/hint';
import { HEAD, NUM, TABLE_FRAME, WIDE_ONLY } from '@/components/table-parts';
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

const COLUMNS = 8;

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
    <ConsoleShell title="Цены" cabinet="client">
      {() => <MyPrices />}
    </ConsoleShell>
  );
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
      <label className="flex w-[280px] flex-col gap-1">
        <span className="flex items-center gap-1 text-muted-foreground">
          Оператор
          <Hint label="Как считается цена вызова">
            <p>
              Цена вызова — плата за соединение плюс время. Время считается шагами: при шаге в
              минуту разговор в 10 секунд оплачивается как полная минута, при посекундном — как 10
              секунд. Поэтому сравнивайте столбец «Вызов 15 / 30 / 60 с» — во что обойдётся вызов
              целиком.
            </p>
          </Hint>
        </span>
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

      <div className={TABLE_FRAME}>
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className={HEAD}>Предложение</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Через что</TableHead>
              <TableHead className={HEAD}>Направление</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Регион</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Как считается время</TableHead>
              <TableHead className={`${HEAD} text-right ${WIDE_ONLY}`}>За соединение</TableHead>
              <TableHead className={`${HEAD} text-right ${WIDE_ONLY}`}>За минуту</TableHead>
              <TableHead className={`${HEAD} text-right`}>Вызов 15 / 30 / 60 с</TableHead>
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
                {/* Способ и регион — своими столбцами, а не второй строкой под названием (DESIGN.md, «Таблица»). */}
                <TableCell className="whitespace-nowrap">{row.display_name}</TableCell>

                <TableCell
                  className={`whitespace-nowrap ${WIDE_ONLY}`}
                  title={TERMINATION_KIND_MEANING[row.termination_kind]}
                >
                  {TERMINATION_KIND_NAME[row.termination_kind]}
                </TableCell>

                <TableCell className="whitespace-nowrap">
                  {operators.nameOf(row.operator_id) ?? (
                    <span className="num text-faint">{row.operator_id}</span>
                  )}
                </TableCell>

                <TableCell className={`whitespace-nowrap ${WIDE_ONLY}`}>
                  {row.region ?? <span className="text-faint">любой</span>}
                </TableCell>

                <TableCell className={`whitespace-nowrap ${WIDE_ONLY}`}>{billing(row)}</TableCell>

                <TableCell className={`${NUM} ${WIDE_ONLY}`}>{money(row.connection_fee)}</TableCell>
                <TableCell className={`${NUM} ${WIDE_ONLY}`}>
                  {money(row.price_per_minute)}
                </TableCell>

                <TableCell className={`${NUM} whitespace-nowrap`}>
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
