'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { MessengerAccountStatus } from '@/components/messenger-status';
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
import { MESSAGE_FAILURE_NAME, MESSAGE_STATUS_NAME, messageTone } from '@/lib/labels';
import { money } from '@/lib/money';
import type { PartnerRow } from '../partners/partner-row';

interface StaffMessage {
  readonly id: string;
  readonly to: string;
  readonly status: string;
  readonly failure_reason: string | null;
  readonly created_at: string;
  readonly money: { client: string; partner: string; margin: string };
}

interface Account {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly phone: string | null;
  readonly price: string | null;
  readonly limit_per_minute: number | null;
  readonly limit_per_day: number | null;
  readonly state_reason: string | null;
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
            Продукт включается и ключ провайдера вписывается в «Настройки площадки» → «Сообщения
            MAX», наценка — в «Тарифы и наценка».
          </p>
        </div>
      )}

      <h2 className="font-semibold">Аккаунты партнёров</h2>
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
                  <MessengerAccountStatus
                    status={account.status}
                    reason={account.state_reason}
                    staff
                  />
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
                      label="Удалить"
                      title={`Удалить аккаунт «${account.label}» партнёра ${account.partner_name}`}
                      consequence={
                        <p>
                          Аккаунт перестанет принимать сообщения, подключение у провайдера будет
                          удалено. Вернуть нельзя.
                        </p>
                      }
                      confirmLabel="Удалить"
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

      <SmppConnections />

      <RecentMessages />
    </div>
  );
}

/** Последние сообщения всех клиентов: статус и деньги по трём счетам; текст сотруднику не показывается. */
function RecentMessages() {
  const list = useQuery({
    queryKey: ['messages', 'recent'],
    queryFn: ({ signal }) =>
      request<{ messages: StaffMessage[]; total: number }>('/messages?limit=50', { signal }),
    refetchInterval: 15_000,
  });
  const error = list.error instanceof ApiError ? list.error : undefined;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold">Последние сообщения</h2>
      {error !== undefined && <ErrorNote error={error} />}
      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Когда</TableHead>
              <TableHead className="h-8">Кому</TableHead>
              <TableHead className="h-8">Итог</TableHead>
              <TableHead className="h-8 text-right">Клиент</TableHead>
              <TableHead className="h-8 text-right">Партнёру</TableHead>
              <TableHead className="h-8 text-right">Площадке</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data?.messages.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="text-muted-foreground">
                  Сообщений пока нет.
                </TableCell>
              </TableRow>
            )}
            {list.data?.messages.map((message) => (
              <TableRow key={message.id}>
                <TableCell>
                  <span className="num text-muted-foreground">{moment(message.created_at)}</span>
                </TableCell>
                <TableCell>
                  <span className="num">{message.to}</span>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <span className={`rounded-md px-2 py-0.5 ${messageTone(message.status)}`}>
                    {MESSAGE_STATUS_NAME[message.status] ?? message.status}
                  </span>
                  {message.failure_reason !== null && (
                    <span className="block pt-0.5 text-muted-foreground">
                      {MESSAGE_FAILURE_NAME[message.failure_reason] ?? message.failure_reason}
                    </span>
                  )}
                </TableCell>
                <TableCell className="num text-right">{money(message.money.client)}</TableCell>
                <TableCell className="num text-right">{money(message.money.partner)}</TableCell>
                <TableCell className="num text-right">{money(message.money.margin)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
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

interface SmppConnection {
  readonly client_id: string;
  readonly client_name: string | null;
  readonly system_id: string;
  readonly enabled: boolean;
  readonly allowed_ips: readonly string[];
  readonly last_bind_at: string | null;
}

/**
 * Подключения клиентов по SMPP ([ADR-0072](../../../../../docs/adr/0072-smpp-dlya-soobscheniy.md)): кто подключён и
 * когда заходил в последний раз. Администратор может отключить подключение (например, при подозрении на утечку
 * пароля) и вернуть его; пароль и адреса клиента он не видит и не меняет. Пока подключений нет, блока нет.
 */
function SmppConnections() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['smpp', 'accounts'],
    queryFn: ({ signal }) => request<{ accounts: SmppConnection[] }>('/smpp/accounts', { signal }),
    refetchInterval: 30_000,
  });
  const toggle = useMutation({
    mutationFn: (input: { clientId: string; enabled: boolean }) =>
      request<unknown>(`/smpp/accounts/${input.clientId}`, {
        method: 'PATCH',
        body: { enabled: input.enabled },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['smpp', 'accounts'] }),
  });

  const accounts = list.data?.accounts ?? [];
  if (accounts.length === 0) return null;

  return (
    <section aria-label="Подключения по SMPP" className="flex flex-col gap-2">
      <h2 className="font-semibold">Подключения клиентов по SMPP</h2>
      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Клиент</TableHead>
              <TableHead className="h-8">Имя входа</TableHead>
              <TableHead className="h-8">Адреса</TableHead>
              <TableHead className="h-8">Был на связи</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              {canChange && <TableHead className="h-8" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => (
              <TableRow key={account.client_id}>
                <TableCell>{account.client_name ?? account.client_id}</TableCell>
                <TableCell>
                  <span className="num">{account.system_id}</span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {account.allowed_ips.length === 0
                    ? 'любые'
                    : `ограничены: ${String(account.allowed_ips.length)}`}
                </TableCell>
                <TableCell>
                  <span className="num text-muted-foreground">{moment(account.last_bind_at)}</span>
                </TableCell>
                <TableCell className={account.enabled ? 'text-ok' : 'text-warn'}>
                  {account.enabled ? 'Включено' : 'Отключено'}
                </TableCell>
                {canChange && (
                  <TableCell className="text-right">
                    {account.enabled ? (
                      <ConfirmAction
                        label="Отключить"
                        title={`Отключить SMPP клиента «${account.client_name ?? account.system_id}»`}
                        consequence="Новые подключения клиента будут отклоняться, пока вы не включите его снова. Открытые сессии доживут до разрыва."
                        confirmLabel="Отключить"
                        size="xs"
                        onConfirm={() =>
                          toggle.mutateAsync({ clientId: account.client_id, enabled: false })
                        }
                      />
                    ) : (
                      <button
                        type="button"
                        disabled={toggle.isPending}
                        onClick={() => {
                          toggle.mutate({ clientId: account.client_id, enabled: true });
                        }}
                        className="min-h-7 rounded-md border border-border px-2 hover:bg-muted"
                      >
                        Включить
                      </button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
