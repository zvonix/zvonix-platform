'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { WARMUP_DAYS } from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import {
  AccountRestNote,
  MessengerAccountStatus,
  type AccountRest,
} from '@/components/messenger-status';
import { BotPlatform } from './bot-platform';
import {
  JournalFilters,
  JournalPages,
  journalSearch,
  useJournalFilter,
} from '@/components/message-journal';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { ReadOnly } from '@/components/read-only';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
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
import { loadAllRows } from '@/lib/csv';
import { moment } from '@/lib/format';
import { MESSAGE_FAILURE_NAME, MESSAGE_STATUS_NAME, messageTone } from '@/lib/labels';
import { money } from '@/lib/money';
import type { PartnerRow } from '../partners/partner-row';

interface StaffMessage {
  readonly id: string;
  readonly client_id: string;
  readonly to: string;
  readonly status: string;
  readonly failure_reason: string | null;
  readonly created_at: string;
  /** Когда ушло в MAX — по разнице с приёмом видно, сколько ждало (разбор владельца 2026-10-23). */
  readonly sent_at: string | null;
  readonly attempts: number;
  readonly money: { client: string; partner: string; margin: string };
}

interface Account {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly phone: string | null;
  readonly price: string | null;
  readonly limit_per_minute: number | null;
  readonly limit_per_hour: number | null;
  readonly limit_per_day: number | null;
  readonly warmup_enabled: boolean;
  readonly warmup_day: number | null;
  readonly paused_until: string | null;
  /** Включена «рекомендованная работа»: лимиты тарифа заменены профилем площадки (ADR-0090). */
  readonly recommended: boolean;
  /** Почему сейчас на паузе и до какого времени; пусто — работает. */
  readonly rest?: AccountRest;
  readonly pause_reason: string | null;
  readonly daily_limit_now: number | null;
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

  const warmup = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      request<unknown>(`/messenger/accounts/${input.id}/warmup`, {
        method: 'PATCH',
        body: { enabled: input.enabled },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  const resume = useMutation({
    mutationFn: (id: string) =>
      request<unknown>(`/messenger/accounts/${id}/resume`, { method: 'POST' }),
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
          {/* Настройки и наценка — ссылками, а не абзацем с путём по меню (осмотр 2026-10-21). */}
          <Button asChild variant="outline">
            <Link href="/settings?section=messaging">Настройки MAX</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/tariffs?tab=max">Наценка</Link>
          </Button>
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
              <TableHead className="h-8 text-right">Цена</TableHead>
              <TableHead className="h-8 text-right" title="Предел в минуту / в час">
                Мин / час
              </TableHead>
              <TableHead className="h-8 text-right" title="Сколько ещё можно отправить сегодня">
                Сегодня
              </TableHead>
              <TableHead className="h-8">
                <span className="inline-flex items-center gap-1">
                  Прогрев
                  <Hint label="Что такое автопрогрев">
                    <p>
                      MAX блокирует новые номера, которые сразу шлют много. Автопрогрев начинает с
                      12 сообщений в сутки, за неделю доходит до 100 и за месяц — до лимита в сутки
                      из тарифа (нет лимита — 500). Сообщения уходят равномерно, а не пачкой, то,
                      что не влезло, ждёт или идёт через другой аккаунт. Получил ограничение от MAX
                      — прогрев начинается заново.
                    </p>
                  </Hint>
                </span>
              </TableHead>
              <TableHead className="h-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}
            {list.data?.accounts.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="whitespace-normal text-muted-foreground">
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
                  {/* Время сверки — мелкой строкой под состоянием, а не отдельным столбцом: таблица влезает в 1280. */}
                  {account.state_checked_at !== null && (
                    <span className="num block text-xs text-faint">
                      сверено {moment(account.state_checked_at)}
                    </span>
                  )}
                  <AccountRestNote rest={account.rest} />
                  {account.paused_until !== null && (
                    <span className="mt-1 block">
                      {canChange && (
                        <Button
                          variant="outline"
                          size="xs"
                          className="ml-2"
                          disabled={resume.isPending}
                          onClick={() => {
                            resume.mutate(account.id);
                          }}
                        >
                          Снять паузу
                        </Button>
                      )}
                    </span>
                  )}
                </TableCell>
                <TableCell className="num text-right">
                  {account.price === null ? (
                    <span className="text-faint">не задана</span>
                  ) : (
                    money(account.price)
                  )}
                </TableCell>
                <TableCell className="num text-right">
                  {account.recommended ? (
                    <span
                      className="font-sans text-muted-foreground"
                      title="Рекомендованная работа: темп и лимиты — профиль площадки, лимиты тарифа не применяются"
                    >
                      рекомендованные
                    </span>
                  ) : (
                    <>
                      {account.limit_per_minute === null ? '—' : String(account.limit_per_minute)}
                      {' / '}
                      {account.limit_per_hour === null ? '—' : String(account.limit_per_hour)}
                    </>
                  )}
                </TableCell>
                <TableCell className="num text-right">
                  {account.daily_limit_now === null ? '—' : String(account.daily_limit_now)}
                </TableCell>
                <TableCell>
                  {/* Прогрев одной строкой: где он, на какой день и выключатель (владелец: «прогрев где-то непонятно где»). */}
                  <span className="inline-flex items-center gap-2">
                    {canChange && (
                      <Switch
                        aria-label={`Автопрогрев аккаунта «${account.label}»`}
                        checked={account.warmup_enabled}
                        disabled={warmup.isPending}
                        onCheckedChange={(enabled) => {
                          warmup.mutate({ id: account.id, enabled });
                        }}
                      />
                    )}
                    {!account.warmup_enabled ? (
                      <span className="text-muted-foreground">выключен</span>
                    ) : account.warmup_day === null ? (
                      <span className="text-muted-foreground">пройден</span>
                    ) : (
                      <span className="num">
                        {String(account.warmup_day + 1)}-е сутки из {String(WARMUP_DAYS)}
                      </span>
                    )}
                  </span>
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

      <BotPlatform />

      <RecentMessages />
    </div>
  );
}

/** Последние сообщения всех клиентов: статус и деньги по трём счетам; текст сотруднику не показывается. */
function RecentMessages() {
  const [filter, changeFilter] = useJournalFilter();
  const [clientId, setClientId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const search = journalSearch(filter, { clientId, partnerId });
  const list = useQuery({
    queryKey: ['messages', 'recent', search.toString()],
    queryFn: ({ signal }) =>
      request<{ messages: StaffMessage[]; total: number }>(`/messages?${search.toString()}`, {
        signal,
      }),
    refetchInterval: 15_000,
  });
  const clients = useQuery({
    queryKey: ['clients', 'names'],
    queryFn: ({ signal }) =>
      request<{ clients: { id: string; name: string }[] }>('/clients?limit=200', { signal }),
    staleTime: 60_000,
  });
  const partners = useQuery({
    queryKey: ['partners', 'verified-list'],
    queryFn: ({ signal }) =>
      request<{ partners: PartnerRow[] }>('/partners?status=verified&limit=200', { signal }),
  });
  const error = list.error instanceof ApiError ? list.error : undefined;
  const clientName = (id: string): string =>
    clients.data?.clients.find((client) => client.id === id)?.name ?? '';

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold">Журнал сообщений</h2>
      <JournalFilters
        filter={filter}
        onChange={changeFilter}
        exportName="сообщения-max"
        load={async () => {
          const filters = journalSearch(filter, { clientId, partnerId });
          filters.delete('offset');
          const found = await loadAllRows<StaffMessage>('/messages', filters, 'messages');
          return {
            header: [
              'Принято',
              'Ушло',
              'Попыток',
              'Клиент',
              'Кому',
              'Итог',
              'Клиент, ₽',
              'Партнёру, ₽',
              'Площадке, ₽',
            ],
            rows: found.rows.map((message) => [
              moment(message.created_at),
              message.sent_at === null ? '' : moment(message.sent_at),
              message.attempts,
              clientName(message.client_id),
              message.to,
              MESSAGE_STATUS_NAME[message.status] ?? message.status,
              message.money.client,
              message.money.partner,
              message.money.margin,
            ]),
            truncated: found.truncated,
          };
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Клиент</span>
          <select
            value={clientId}
            onChange={(event) => {
              setClientId(event.target.value);
              changeFilter({});
            }}
            className="h-9 w-[200px] rounded-md border border-input bg-transparent px-2"
          >
            <option value="">любой</option>
            {(clients.data?.clients ?? []).map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Партнёр</span>
          <select
            value={partnerId}
            onChange={(event) => {
              setPartnerId(event.target.value);
              changeFilter({});
            }}
            className="h-9 w-[200px] rounded-md border border-input bg-transparent px-2"
          >
            <option value="">любой</option>
            {(partners.data?.partners ?? []).map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.name}
              </option>
            ))}
          </select>
        </label>
      </JournalFilters>
      {error !== undefined && <ErrorNote error={error} />}
      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Принято</TableHead>
              <TableHead className="h-8">Ушло</TableHead>
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
                <TableCell colSpan={7} className="text-muted-foreground">
                  По этому отбору сообщений нет.
                </TableCell>
              </TableRow>
            )}
            {list.data?.messages.map((message) => (
              <TableRow key={message.id}>
                <TableCell>
                  <span className="num text-muted-foreground">{moment(message.created_at)}</span>
                </TableCell>
                <TableCell>
                  <span className="num text-muted-foreground">
                    {message.sent_at === null ? '—' : moment(message.sent_at)}
                  </span>
                  {message.attempts > 1 && (
                    <span className="block text-faint">попыток {String(message.attempts)}</span>
                  )}
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
      <JournalPages filter={filter} total={list.data?.total} onChange={changeFilter} />
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
