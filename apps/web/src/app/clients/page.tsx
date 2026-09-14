'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLIENT_STATUSES, type ClientStatus } from '@zvonix/shared';
import { Suspense, useState } from 'react';
import { AccountLedger } from '@/components/account-ledger';
import { Choice } from '@/components/choice';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { FilterInput } from '@/components/filter-input';
import { PageNav } from '@/components/page-nav';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReadOnly } from '@/components/read-only';
import { SipCredentials, type IssuedCredentials } from '@/components/sip-credentials';
import { useCanChange } from '@/lib/access';
import { ErrorNote } from '@/components/error-note';
import { ApiError, request } from '@/lib/api';
import { atMost } from '@/lib/wait';
import { moment } from '@/lib/format';
import { CLIENT_STATUS_MEANING, CLIENT_STATUS_NAME, clientStatusTone } from '@/lib/labels';
import { isNegative, money, moneyFromInput } from '@/lib/money';
import { useUrlState } from '@/lib/url-state';
import { ClientChannels } from './client-channels';
import { DepositForm } from './deposit-form';
import { NewClientForm } from './new-client-form';

const PAGE_SIZE = 50;
const COLUMNS = 6;

/** Кнопка называет действие, а не состояние, в которое переводит. */
const CLIENT_ACTION: Record<ClientStatus, string> = {
  pending: 'Вернуть в «ждёт допуска»',
  active: 'Разрешить звонить',
  suspended: 'Приостановить',
  closed: 'Закрыть навсегда',
};

export interface ClientRow {
  readonly id: string;
  readonly name: string;
  readonly status: ClientStatus;
  readonly overdraft_limit: string;
  readonly balance: string;
  readonly created_at: string;
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

export default function ClientsPage() {
  return (
    <ConsoleShell title="Клиенты и деньги" requireRole={['admin', 'support']}>
      {() => (
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <ClientsTable />
        </Suspense>
      )}
    </ConsoleShell>
  );
}

function ClientsTable() {
  const canChange = useCanChange();
  const url = useUrlState();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [issued, setIssued] = useState<readonly IssuedCredentials[]>([]);

  const offset = Number.parseInt(url.get('offset'), 10) || 0;
  const search = new URLSearchParams(url.query);
  search.set('limit', String(PAGE_SIZE));

  const list = useQuery({
    queryKey: ['clients', search.toString()],
    queryFn: () =>
      request<{ clients: ClientRow[]; total: number }>(`/clients?${search.toString()}`),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['clients'] });
  };

  const activate = useMutation({
    mutationFn: (id: string) =>
      request<unknown>(`/clients/${id}/status`, {
        method: 'PATCH',
        body: { status: 'active' },
      }),
    onSuccess: invalidate,
  });

  // Подтверждаемые действия — своими мутациями: их отказ виден в окне подтверждения
  // и не повторяется над таблицей.
  const confirmStatus = useMutation({
    mutationFn: (input: { id: string; status: ClientStatus }) =>
      request<unknown>(`/clients/${input.id}/status`, {
        method: 'PATCH',
        body: { status: input.status },
      }),
    onSuccess: () => atMost(invalidate()),
  });

  const overdraft = useMutation({
    mutationFn: (input: { id: string; value: string }) =>
      request<unknown>(`/clients/${input.id}/overdraft`, {
        method: 'PATCH',
        body: { overdraftLimit: input.value },
      }),
    onSuccess: () => atMost(invalidate()),
  });

  const changeError = asApiError(activate.error);
  const listError = asApiError(list.error);

  return (
    <div className="flex flex-col gap-3">
      {canChange ? <NewClientForm /> : <ReadOnly what="клиентов, их каналы и деньги" />}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Название</span>
          <FilterInput
            className="w-[220px]"
            placeholder="часть названия"
            value={url.get('name')}
            onChange={(name) => {
              url.set({ name, offset: '' });
            }}
          />
        </label>

        <Choice
          label="Состояние"
          anyLabel="любое"
          value={url.get('status')}
          options={CLIENT_STATUSES.map((status) => [status, CLIENT_STATUS_NAME[status]])}
          onChange={(value) => {
            url.set({ status: value, offset: '' });
          }}
        />

        <div className="ml-auto">
          <PageNav
            offset={offset}
            limit={PAGE_SIZE}
            total={list.data?.total ?? 0}
            onChange={(next) => {
              url.set({ offset: next === 0 ? '' : String(next) });
            }}
          />
        </div>
      </div>

      {changeError !== undefined && <ErrorNote error={changeError} />}
      {listError !== undefined && <ErrorNote error={listError} />}

      {/*
        Выданный пароль канала — здесь, над таблицей, а не в строке клиента: строку сворачивают,
        и панель пропадала вместе с ней. Второго показа пароля не будет. Панелей может быть
        несколько: пароль второго канала не затирает незакрытый пароль первого.
      */}
      {issued.map((secret) => (
        <SipCredentials
          key={secret.account.username}
          account={secret.account}
          title={secret.title}
          onClose={() => {
            setIssued((list) => list.filter((item) => item !== secret));
          }}
        />
      ))}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Название</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8 text-right">Остаток</TableHead>
              <TableHead className="h-8 text-right">Разрешённый минус</TableHead>
              <TableHead className="h-8">Заведён</TableHead>
              <TableHead className="h-8"> </TableHead>
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

            {list.data?.clients.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  По этому отбору клиентов нет.
                </TableCell>
              </TableRow>
            )}

            {list.data?.clients.map((client) => (
              <ClientRows
                key={client.id}
                client={client}
                open={opened === client.id}
                busy={activate.isPending || confirmStatus.isPending}
                onToggle={() => {
                  setOpened(opened === client.id ? undefined : client.id);
                }}
                onActivate={() => {
                  activate.mutate(client.id);
                }}
                onConfirmStatus={(status) => confirmStatus.mutateAsync({ id: client.id, status })}
                onOverdraft={(value) => overdraft.mutateAsync({ id: client.id, value })}
                onIssued={(secret) => {
                  setIssued((list) => [...list, secret]);
                }}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ClientRows({
  client,
  open,
  busy,
  onToggle,
  onActivate,
  onConfirmStatus,
  onOverdraft,
  onIssued,
}: {
  client: ClientRow;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onActivate: () => void;
  onConfirmStatus: (status: ClientStatus) => Promise<unknown>;
  onOverdraft: (value: string) => Promise<unknown>;
  onIssued: (issued: IssuedCredentials) => void;
}) {
  const canChange = useCanChange();
  return (
    <>
      <TableRow>
        <TableCell>{client.name}</TableCell>
        <TableCell>
          <span className={`rounded-sm px-1.5 py-0.5 ${clientStatusTone(client.status)}`}>
            {CLIENT_STATUS_NAME[client.status]}
          </span>
        </TableCell>
        <TableCell className="num text-right">
          {/*
            Отрицательный остаток выделяется, но не паникой: при разрешённом минусе
            это штатное состояние, а не авария (DESIGN.md).
          */}
          <span className={isNegative(client.balance) ? 'text-warn' : undefined}>
            {money(client.balance)}
          </span>
        </TableCell>
        <TableCell className="num text-right text-muted-foreground">
          {money(client.overdraft_limit)}
        </TableCell>
        <TableCell>
          <span className="num text-muted-foreground">{moment(client.created_at)}</span>
        </TableCell>
        <TableCell>
          <Button variant="outline" size="sm" onClick={onToggle} aria-expanded={open}>
            {open ? 'Свернуть' : 'Деньги'}
          </Button>
        </TableCell>
      </TableRow>

      {open && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={COLUMNS} className="whitespace-normal">
            <div className="flex flex-col gap-4">
              {canChange && (
                <>
                  <StatusChoice
                    client={client}
                    busy={busy}
                    onActivate={onActivate}
                    onConfirmStatus={onConfirmStatus}
                  />
                  <OverdraftField client={client} onSave={onOverdraft} />
                </>
              )}
              <ClientChannels
                clientId={client.id}
                onIssued={(secret) => {
                  onIssued({ ...secret, title: `${secret.title} — клиент «${client.name}»` });
                }}
              />
              {canChange && <DepositForm client={client} />}
              <AccountLedger source={`/clients/${client.id}/entries`} account="client" />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * Смена состояния клиента.
 *
 * Последствие не косметическое: маршрутизация требует `active` **и от канала, и от клиента**,
 * поэтому любое другое состояние означает «ни один канал не звонит». Разрешение звонить —
 * одним нажатием; остановка и закрытие — через подтверждение с названным последствием
 * ([DESIGN.md](../../../../../docs/DESIGN.md)): раньше и необратимое «Закрыт» срабатывало
 * с первого нажатия (ui-review, 2026-09-14). Из `closed` вариантов нет вовсе: переход
 * необратим, и предлагать его обратно — обещать то, чего API не сделает.
 */
function StatusChoice({
  client,
  busy,
  onActivate,
  onConfirmStatus,
}: {
  client: ClientRow;
  busy: boolean;
  onActivate: () => void;
  onConfirmStatus: (status: ClientStatus) => Promise<unknown>;
}) {
  if (client.status === 'closed') {
    return (
      <p className="text-muted-foreground">
        Клиент закрыт. Это состояние окончательное — вернуть его в работу нельзя, нужен новый
        клиент.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold">Состояние</h3>
      <p className="text-muted-foreground">
        Сейчас — {CLIENT_STATUS_NAME[client.status].toLowerCase()}:{' '}
        {CLIENT_STATUS_MEANING[client.status]} Смена попадает в журнал вместе с тем, что было до.
      </p>
      <div className="flex flex-wrap gap-2">
        {CLIENT_STATUSES.filter((status) => status !== client.status).map((status) =>
          status === 'active' ? (
            <Button key={status} variant="outline" size="sm" disabled={busy} onClick={onActivate}>
              {CLIENT_ACTION[status]}
            </Button>
          ) : (
            <ConfirmAction
              key={status}
              label={CLIENT_ACTION[status]}
              title={`${CLIENT_ACTION[status]}: клиент «${client.name}»`}
              consequence={<p>{CLIENT_STATUS_MEANING[status]}</p>}
              confirmLabel={CLIENT_ACTION[status]}
              disabled={busy}
              onConfirm={() => onConfirmStatus(status)}
            />
          ),
        )}
      </div>
    </div>
  );
}

/**
 * Разрешённый минус.
 *
 * До появления обработчика задавался только при заведении и потом не менялся ничем:
 * опечатка в разрядах означала кредит, который нечем отозвать. Правка денежная,
 * поэтому попадает в журнал вместе с прежним значением.
 *
 * Форма с кнопкой и подтверждением «было → станет», а не отправка по потере фокуса:
 * раньше щелчок мимо поля уже выдавал кредит, в поле стоял машинный `1500.5` вместо
 * `1 500,5 ₽`, а отказ показывался над таблицей, далеко от поля (ui-review, 2026-09-14).
 */
function OverdraftField({
  client,
  onSave,
}: {
  client: ClientRow;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState('');
  const typed = moneyFromInput(value);
  const valid = typed !== undefined;
  const shown = valid ? money(typed) : '';

  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-semibold">Разрешённый минус</h3>
      <p className="text-muted-foreground">
        Сейчас — <span className="num">{money(client.overdraft_limit)}</span>: насколько глубоко
        клиенту разрешено уходить в минус. Ноль — только на свои. Уменьшение ниже текущего долга
        допустимо: это «больше в долг не даём», потраченное при этом никуда не девается.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Новый минус, ₽</span>
          <Input
            className="num w-[140px]"
            inputMode="decimal"
            autoComplete="off"
            placeholder="10 000,00"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </label>
        <ConfirmAction
          label="Изменить"
          tone="neutral"
          disabled={!valid}
          title={`Разрешённый минус: «${client.name}»`}
          consequence={
            <>
              <p>
                Было: <b className="num">{money(client.overdraft_limit)}</b>. Станет:{' '}
                <b className="num">{shown}</b>.
              </p>
              <p>
                Правка действует на новые вызовы сразу и попадает в журнал вместе с прежним
                значением.
              </p>
            </>
          }
          confirmLabel={`Установить ${shown}`}
          onConfirm={async () => {
            if (typed === undefined) return;
            await onSave(typed);
            setValue('');
          }}
        />
      </div>
      {value !== '' && !valid && (
        <p className="text-warn">
          Сумма — число, не больше шести знаков после запятой: например 10 000,50.
        </p>
      )}
    </div>
  );
}
