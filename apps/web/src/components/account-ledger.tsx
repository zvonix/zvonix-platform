'use client';

import { useQuery } from '@tanstack/react-query';
import type { TransactionKind } from '@zvonix/shared';
import { useState } from 'react';
import { PageNav } from '@/components/page-nav';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';
import { moment } from '@/lib/format';
import { TRANSACTION_KIND_NAME } from '@/lib/labels';
import { isNegative, money } from '@/lib/money';

const PAGE_SIZE = 20;

interface Entry {
  readonly seq: string;
  readonly transaction_id: string;
  readonly amount: string;
  readonly kind: TransactionKind;
  readonly description: string;
  readonly reference_type: string | null;
  readonly reference_id: string | null;
  readonly created_at: string;
}

/**
 * Движение денег по счёту участника.
 *
 * Лента одна на всех намеренно: журнал проводок устроен одинаково у клиента,
 * у партнёра и в собственном кабинете клиента, и вторая копия таблицы разъехалась бы
 * с первой на первой же правке. Отличается только адрес — его и передают:
 * `/clients/:id/entries`, `/partners/:id/entries`, `/client/entries`.
 *
 * Страница этого списка живёт в состоянии компонента, а не в адресе: в адресе уже
 * есть отбор участников, и подмешивать туда страницу раскрытой карточки значило бы
 * получить ссылку, которая при открытии показывает не то, что было у отправителя.
 */
export function AccountLedger({ source }: { source: string }) {
  const [offset, setOffset] = useState(0);

  const list = useQuery({
    queryKey: ['entries', source, offset],
    queryFn: () =>
      request<{ entries: Entry[]; balance: string; total: number }>(
        `${source}?limit=${String(PAGE_SIZE)}&offset=${String(offset)}`,
      ),
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h3 className="font-semibold">Движение денег</h3>
        <div className="ml-auto">
          <PageNav
            offset={offset}
            limit={PAGE_SIZE}
            total={list.data?.total ?? 0}
            onChange={setOffset}
          />
        </div>
      </div>

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className="max-w-[900px] rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Когда</TableHead>
              <TableHead className="h-8">Что произошло</TableHead>
              <TableHead className="h-8">Основание</TableHead>
              <TableHead className="h-8 text-right">Сумма</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {list.data?.entries.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="text-muted-foreground">
                  По этому счёту движения не было.
                </TableCell>
              </TableRow>
            )}

            {list.data?.entries.map((entry) => (
              <TableRow key={entry.seq}>
                <TableCell>
                  <span className="num text-muted-foreground">{moment(entry.created_at)}</span>
                </TableCell>
                <TableCell>{TRANSACTION_KIND_NAME[entry.kind]}</TableCell>
                <TableCell className="whitespace-normal">
                  {entry.description}
                  {/*
                    Ссылка на породившее событие: по вызову разбирают спор о списании.
                    Ссылка на самого клиента здесь не показывается — эта лента и так его,
                    и повторять его идентификатор в каждой строке значит прятать за шумом
                    те ссылки, ради которых столбец и заведён.
                  */}
                  {entry.reference_id !== null && entry.reference_type !== 'client' && (
                    <span className="num block text-faint">
                      {entry.reference_type} {entry.reference_id}
                    </span>
                  )}
                </TableCell>
                <TableCell className="num text-right">
                  <span className={isNegative(entry.amount) ? 'text-crit' : 'text-ok'}>
                    {money(entry.amount)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
