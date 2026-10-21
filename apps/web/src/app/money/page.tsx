'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Suspense } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { FilterInput } from '@/components/filter-input';
import { MoneyOperation } from '@/components/money-operation';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCanChange } from '@/lib/access';
import { request } from '@/lib/api';
import { isNegative, money } from '@/lib/money';
import { useUrlState } from '@/lib/url-state';
import type { PartnerRow } from '../partners/partner-row';

const LIMIT = 100;

interface ClientMoney {
  readonly id: string;
  readonly name: string;
  readonly balance: string;
}

export default function MoneyPage() {
  return (
    <ConsoleShell title="Счета и пополнение" requireRole={['admin', 'support']}>
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <Accounts />
        </Suspense>
      )}
    </ConsoleShell>
  );
}

/**
 * Счета клиентов и партнёров на одной странице: остаток и «Пополнить» в строке, без захода в карточку
 * ([ADR-0090](../../../../../docs/adr/0090-dengi-admina-i-limity-akkaunta.md)). Вкладка и поиск живут в адресе.
 */
function Accounts() {
  const url = useUrlState();
  const canChange = useCanChange();
  const partners = url.get('tab') === 'partners';
  const name = url.get('name');

  const query = new URLSearchParams({ limit: String(LIMIT) });
  if (name !== '') query.set('name', name);
  const clients = useQuery({
    queryKey: ['clients', 'money', query.toString()],
    enabled: !partners,
    queryFn: () =>
      request<{ clients: ClientMoney[]; total: number }>(`/clients?${query.toString()}`),
  });
  const owners = useQuery({
    queryKey: ['partners', 'money', query.toString()],
    enabled: partners,
    queryFn: () =>
      request<{ partners: PartnerRow[]; total: number }>(`/partners?${query.toString()}`),
  });
  const list = partners ? owners : clients;
  const total = list.data?.total ?? 0;
  const rows: readonly { id: string; name: string; balance: string }[] = partners
    ? (owners.data?.partners ?? [])
    : (clients.data?.clients ?? []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div role="tablist" aria-label="Чьи счета" className="flex gap-1">
          {(
            [
              [false, 'Клиенты'],
              [true, 'Партнёры'],
            ] as const
          ).map(([isPartners, title]) => (
            <Button
              key={title}
              type="button"
              role="tab"
              aria-selected={partners === isPartners}
              variant={partners === isPartners ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                url.set({ tab: isPartners ? 'partners' : '', name: '' });
              }}
            >
              {title}
            </Button>
          ))}
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Название</span>
          <FilterInput
            className="w-[220px]"
            placeholder="часть названия"
            value={name}
            onChange={(next) => {
              url.set({ name: next });
            }}
          />
        </label>
      </div>

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-8">{partners ? 'Партнёр' : 'Клиент'}</TableHead>
              <TableHead className="h-8 text-right">
                {partners ? 'Причитается' : 'Остаток'}
              </TableHead>
              <TableHead className="h-8"> </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}
            {!list.isPending && rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="text-muted-foreground">
                  Никого не нашли.
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link
                    href={`/${partners ? 'partners' : 'clients'}/${row.id}`}
                    className="hover:underline"
                  >
                    {row.name}
                  </Link>
                </TableCell>
                <TableCell className="num text-right">
                  <span className={isNegative(row.balance) ? 'text-warn' : undefined}>
                    {money(row.balance)}
                  </span>
                </TableCell>
                <TableCell className="w-px">
                  {canChange && (
                    <MoneyOperation
                      path={`/${partners ? 'partners' : 'clients'}/${row.id}/deposit`}
                      label="Пополнить"
                      title={`Пополнить счёт «${row.name}»`}
                      description={
                        partners
                          ? 'Сумма добавится к тому, что причитается партнёру.'
                          : 'Деньги появятся на остатке сразу и станут доступны для звонков.'
                      }
                      reasonPlaceholder="Платёжное поручение № 42 от 07.09.2026"
                      balanceName={partners ? 'Причитается' : 'Остаток'}
                      doneText="Проведено"
                      variant="outline"
                      invalidate={[partners ? 'partners' : 'clients']}
                      reasonOptional
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {total > LIMIT && (
        <p className="text-muted-foreground">
          Показаны первые {String(LIMIT)} из {String(total)}: уточните название.
        </p>
      )}
    </div>
  );
}
