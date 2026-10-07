'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, request } from '@/lib/api';
import { money, moneyFromInput, numberFromInput } from '@/lib/money';
import { ErrorNote } from '@/components/error-note';
import { SectionTabs, type SectionTab } from '@/components/section-tabs';

/**
 * Аккаунты MAX партнёра: цена за сообщение и лимиты задаются на каждый аккаунт. Одни и те же данные и одно и то же
 * окно «Условия» показываются на трёх страницах: «Аккаунты MAX» (всё), «Мои тарифы» (цены) и «Лимиты» (лимиты) —
 * вкладкой «Сообщения MAX» ([ADR-0071](../../../../../../docs/adr/0071-soobscheniya-max.md)).
 */

export interface Account {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly phone: string | null;
  readonly price: string | null;
  readonly limit_per_minute: number | null;
  readonly limit_per_day: number | null;
}

export interface AccountsResponse {
  readonly enabled: boolean;
  readonly accounts: Account[];
}

export const ACCOUNTS_KEY = ['partner', 'messenger', 'accounts'] as const;

export function TermsForm({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(account.label);
  const [price, setPrice] = useState(account.price === null ? '' : numberFromInput(account.price));
  const [perMinute, setPerMinute] = useState(
    account.limit_per_minute === null ? '' : String(account.limit_per_minute),
  );
  const [perDay, setPerDay] = useState(
    account.limit_per_day === null ? '' : String(account.limit_per_day),
  );

  const parseLimit = (text: string): number | null | undefined => {
    if (text.trim() === '') return null;
    return /^\d{1,7}$/u.test(text.trim()) ? Number(text.trim()) : undefined;
  };
  const priceValid = price.trim() === '' || moneyFromInput(price) !== undefined;
  const minuteLimit = parseLimit(perMinute);
  const dayLimit = parseLimit(perDay);
  const valid =
    label.trim().length >= 2 && priceValid && minuteLimit !== undefined && dayLimit !== undefined;

  const save = useMutation({
    mutationFn: () =>
      request<{ account: Account }>(`/partner/messenger/accounts/${account.id}`, {
        method: 'PATCH',
        body: {
          label: label.trim(),
          price: price.trim() === '' ? null : numberFromInput(price),
          limitPerMinute: minuteLimit,
          limitPerDay: dayLimit,
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  });

  return (
    <DialogForm submitLabel="Сохранить" canSubmit={valid} onSubmit={() => save.mutateAsync()}>
      <DialogField label="Название" wide>
        <Input
          autoComplete="off"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />
      </DialogField>
      <DialogField
        label="Цена за сообщение, ₽"
        hint="От 0,01 до 100. Пусто — аккаунт сообщений не принимает."
      >
        <Input
          className="num"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0,45"
          value={price}
          onChange={(event) => {
            setPrice(event.target.value);
          }}
        />
      </DialogField>
      <DialogField label="В минуту" hint="Пусто — без ограничения. Лишнее ждёт в очереди.">
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          value={perMinute}
          onChange={(event) => {
            setPerMinute(event.target.value);
          }}
        />
      </DialogField>
      <DialogField label="В сутки">
        <Input
          className="num"
          inputMode="numeric"
          autoComplete="off"
          value={perDay}
          onChange={(event) => {
            setPerDay(event.target.value);
          }}
        />
      </DialogField>
      {!priceValid && (
        <p className="text-warn sm:col-span-2">
          Цена — число больше нуля, не больше шести знаков после запятой: например 0,45.
        </p>
      )}
      {(minuteLimit === undefined || dayLimit === undefined) && (
        <p className="text-warn sm:col-span-2">Лимит — целое число или пусто.</p>
      )}
    </DialogForm>
  );
}

/** Аккаунты партнёра и признак, что сообщения на площадке вообще включены. */
export function useMessengerAccounts() {
  return useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: ({ signal }) => request<AccountsResponse>('/partner/messenger/accounts', { signal }),
    // Состояние аккаунта сверяет площадка раз в минуту: чаще спрашивать нечего.
    refetchInterval: 30_000,
  });
}

function AccountsTable({
  columns,
  row,
}: {
  columns: readonly { label: string; right?: boolean }[];
  row: (account: Account) => ReactNode[];
}) {
  const list = useMessengerAccounts();
  if (list.error instanceof ApiError) return <ErrorNote error={list.error} />;
  if (list.data === undefined) return <p className="text-muted-foreground">Загружаем…</p>;
  const accounts = list.data.accounts;

  return (
    <div className="rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="text-muted-foreground hover:bg-transparent">
            <TableHead className="h-8">Аккаунт</TableHead>
            {columns.map((column) => (
              <TableHead
                key={column.label}
                className={`h-8 ${column.right === true ? 'text-right' : ''}`}
              >
                {column.label}
              </TableHead>
            ))}
            <TableHead className="h-8" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={columns.length + 2}
                className="whitespace-normal text-muted-foreground"
              >
                Аккаунтов MAX пока нет. Добавьте первый в разделе{' '}
                <Link href="/partner/messages" className="underline underline-offset-2">
                  «Аккаунты MAX»
                </Link>
                .
              </TableCell>
            </TableRow>
          )}
          {accounts.map((account) => (
            <TableRow key={account.id}>
              <TableCell>
                {account.label}
                <span className="num block text-faint">
                  {account.phone ?? 'номер появится после входа'}
                </span>
              </TableCell>
              {row(account).map((cell, index) => (
                <TableCell
                  key={columns[index]?.label ?? 'cell'}
                  className={columns[index]?.right === true ? 'num text-right' : ''}
                >
                  {cell}
                </TableCell>
              ))}
              <TableCell className="text-right">
                <FormDialog
                  label="Изменить"
                  title={`Условия: ${account.label}`}
                  variant="outline"
                  size="xs"
                >
                  <TermsForm account={account} />
                </FormDialog>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Вкладка «Сообщения MAX» страницы «Мои тарифы»: цена за одно сообщение по аккаунтам. */
export function MaxPrices() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">
        Цену за одно сообщение задаёте вы. Клиентам она показывается с наценкой площадки.
      </p>
      <AccountsTable
        columns={[{ label: 'Цена за сообщение', right: true }]}
        row={(account) => [
          account.price === null ? (
            <span className="text-faint">не задана</span>
          ) : (
            money(account.price)
          ),
        ]}
      />
    </div>
  );
}

/** Вкладка «Сообщения MAX» страницы «Лимиты»: сколько сообщений аккаунт отправляет за минуту и за сутки. */
export function MaxLimits() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">
        Лишнее сверх лимита не теряется, а ждёт в очереди. Лимиты защищают аккаунт от блокировки
        MAX.
      </p>
      <AccountsTable
        columns={[
          { label: 'В минуту', right: true },
          { label: 'В сутки', right: true },
        ]}
        row={(account) => [
          account.limit_per_minute === null ? '—' : String(account.limit_per_minute),
          account.limit_per_day === null ? '—' : String(account.limit_per_day),
        ]}
      />
    </div>
  );
}

/**
 * Страница с двумя половинами — «Звонки» и «Сообщения MAX». Вторая вкладка есть, только если сообщения на
 * площадке включены: закрытый продукт не должен обещать вкладку, которая ответит «раздел закрыт».
 */
export function CallsAndMax({ calls, max }: { calls: ReactNode; max: ReactNode }) {
  const accounts = useMessengerAccounts();
  const tabs: SectionTab[] = [{ id: 'calls', label: 'Звонки', content: calls }];
  if (accounts.data?.enabled === true) {
    tabs.push({ id: 'max', label: 'Сообщения MAX', content: max });
  }
  return <SectionTabs tabs={tabs} />;
}
