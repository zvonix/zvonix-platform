'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { ReadOnly } from '@/components/read-only';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import {
  MESSENGER_ACCOUNT_STATUS_MEANING,
  MESSENGER_ACCOUNT_STATUS_NAME,
  messengerAccountTone,
} from '@/lib/labels';
import { money } from '@/lib/money';
import type { PartnerRow } from '../partners/partner-row';

interface Account {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly phone: string | null;
  readonly price: string | null;
  readonly limit_per_minute: number | null;
  readonly limit_per_day: number | null;
  readonly state_checked_at: string | null;
  readonly partner_id: string;
  readonly partner_name: string;
}

const KEY = ['messenger', 'accounts'] as const;

export default function MessagingPage() {
  return (
    <ConsoleShell title="Сообщения MAX" requireRole={['admin', 'support']}>
      {() => <MessagingView />}
    </ConsoleShell>
  );
}

/** Аккаунты MAX всех партнёров: чьи, в каком состоянии, по какой цене (ADR-0071). */
function MessagingView() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => request<{ accounts: Account[] }>('/messenger/accounts', { signal }),
    refetchInterval: 30_000,
  });

  const retire = useMutation({
    mutationFn: (id: string) =>
      request<undefined>(`/messenger/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  const error = list.error instanceof ApiError ? list.error : undefined;

  return (
    <div className="flex flex-col gap-4">
      {!canChange && <ReadOnly what="аккаунты MAX" />}
      {error !== undefined && <ErrorNote error={error} />}

      {canChange && (
        <div className="flex flex-wrap items-center gap-3">
          <FormDialog
            label="Завести вручную"
            title="Аккаунт MAX по данным готового инстанса"
            description="Когда партнёрский ключ провайдера ещё не задан в настройках либо инстанс заведён в кабинете провайдера."
            variant="outline"
          >
            <ManualForm />
          </FormDialog>
          <p className="text-muted-foreground">
            Продукт включается и наценка задаётся в «Настройки площадки» → «Сообщения MAX».
          </p>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Партнёр</TableHead>
              <TableHead className="h-8">Аккаунт</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8 text-right">Цена партнёра</TableHead>
              <TableHead className="h-8 text-right">Лимиты</TableHead>
              <TableHead className="h-8">Сверено</TableHead>
              <TableHead className="h-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}
            {list.data?.accounts.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="whitespace-normal text-muted-foreground">
                  Аккаунтов нет. Партнёры заводят их в своём кабинете, когда продукт включён.
                </TableCell>
              </TableRow>
            )}
            {list.data?.accounts.map((account) => (
              <TableRow key={account.id}>
                <TableCell>{account.partner_name}</TableCell>
                <TableCell>
                  {account.label}
                  <span className="num block text-faint">{account.phone ?? '—'}</span>
                </TableCell>
                <TableCell>
                  <span
                    className={`rounded-md px-2 py-0.5 ${messengerAccountTone(account.status)}`}
                    title={MESSENGER_ACCOUNT_STATUS_MEANING[account.status]}
                  >
                    {MESSENGER_ACCOUNT_STATUS_NAME[account.status] ?? account.status}
                  </span>
                </TableCell>
                <TableCell className="num text-right">
                  {account.price === null ? (
                    <span className="text-faint">не задана</span>
                  ) : (
                    money(account.price)
                  )}
                </TableCell>
                <TableCell className="num text-right">
                  <span className="block">
                    {account.limit_per_minute === null
                      ? '—'
                      : `${String(account.limit_per_minute)}/мин`}
                  </span>
                  <span className="block text-faint">
                    {account.limit_per_day === null ? '—' : `${String(account.limit_per_day)}/сут`}
                  </span>
                </TableCell>
                <TableCell className="num text-muted-foreground">
                  {account.state_checked_at === null ? '—' : moment(account.state_checked_at)}
                </TableCell>
                <TableCell className="text-right">
                  {canChange && (
                    <ConfirmAction
                      label="Списать"
                      title={`Списать аккаунт «${account.label}» партнёра ${account.partner_name}`}
                      consequence={
                        <p>
                          Аккаунт перестанет принимать сообщения, подключение у провайдера будет
                          удалено. Вернуть нельзя.
                        </p>
                      }
                      confirmLabel="Списать"
                      size="xs"
                      onConfirm={() => retire.mutateAsync(account.id)}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ManualForm() {
  const queryClient = useQueryClient();
  const partners = useQuery({
    queryKey: ['partners', 'verified-list'],
    queryFn: ({ signal }) =>
      request<{ partners: PartnerRow[] }>('/partners?status=verified&limit=200', { signal }),
  });

  const [partnerId, setPartnerId] = useState('');
  const [label, setLabel] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [token, setToken] = useState('');
  const [apiUrl, setApiUrl] = useState('');

  const valid =
    partnerId !== '' &&
    label.trim().length >= 2 &&
    instanceId.trim() !== '' &&
    token.trim() !== '' &&
    /^https?:\/\//u.test(apiUrl.trim());

  const register = useMutation({
    mutationFn: () =>
      request<unknown>('/messenger/accounts', {
        method: 'POST',
        body: {
          partnerId,
          label: label.trim(),
          instanceId: instanceId.trim(),
          token: token.trim(),
          apiUrl: apiUrl.trim(),
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  return (
    <DialogForm submitLabel="Завести" canSubmit={valid} onSubmit={() => register.mutateAsync()}>
      <DialogField label="Партнёр" wide>
        <select
          value={partnerId}
          onChange={(event) => {
            setPartnerId(event.target.value);
          }}
          className="h-9 w-full rounded-md border border-input bg-transparent px-2"
        >
          <option value="">выберите</option>
          {(partners.data?.partners ?? []).map((partner) => (
            <option key={partner.id} value={partner.id}>
              {partner.name}
            </option>
          ))}
        </select>
      </DialogField>
      <DialogField label="Название" wide>
        <Input
          autoComplete="off"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />
      </DialogField>
      <DialogField label="Номер инстанса">
        <Input
          className="num"
          autoComplete="off"
          value={instanceId}
          onChange={(event) => {
            setInstanceId(event.target.value);
          }}
        />
      </DialogField>
      <DialogField label="Ключ инстанса" hint="Хранится зашифрованным и в ответах не показывается.">
        <Input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
          }}
        />
      </DialogField>
      <DialogField label="Адрес API инстанса" wide>
        <Input
          autoComplete="off"
          placeholder="https://…"
          value={apiUrl}
          onChange={(event) => {
            setApiUrl(event.target.value);
          }}
        />
      </DialogField>
    </DialogForm>
  );
}
