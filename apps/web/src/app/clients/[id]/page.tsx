'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLIENT_STATUSES, type ClientStatus } from '@zvonix/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AccountLedger } from '@/components/account-ledger';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import { ReadOnly } from '@/components/read-only';
import { SipCredentials, type IssuedCredentials } from '@/components/sip-credentials';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { CLIENT_STATUS_MEANING, CLIENT_STATUS_NAME, clientStatusTone } from '@/lib/labels';
import { isNegative, money, moneyFromInput } from '@/lib/money';
import { atMost } from '@/lib/wait';
import { ClientChannels } from '../client-channels';
import { DepositForm } from '../deposit-form';
import type { ClientRow } from '../page';

/** Кнопка называет действие, а не состояние, в которое переводит. */
const CLIENT_ACTION: Record<ClientStatus, string> = {
  pending: 'Вернуть в «ждёт допуска»',
  active: 'Разрешить звонить',
  suspended: 'Приостановить',
  closed: 'Закрыть навсегда',
};

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/**
 * Клиент по идентификатору — `GET /clients/:id`
 * ([billing.md](../../../../../../docs/api/billing.md)). `null` — такого клиента нет:
 * `undefined` запрос данными не считает. Негодный идентификатор в адресе — тоже «нет».
 */
async function findClient(id: string): Promise<ClientRow | null> {
  try {
    return (await request<{ client: ClientRow }>(`/clients/${encodeURIComponent(id)}`)).client;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

export default function ClientCardPage() {
  return (
    <ConsoleShell title="Клиенты и деньги" requireRole={['admin', 'support']}>
      {() => <ClientCard />}
    </ConsoleShell>
  );
}

/**
 * Карточка клиента: состояние, деньги, каналы, движение денег.
 *
 * Отдельная страница, а не раскрытая строка списка ([DESIGN.md](../../../../../../docs/DESIGN.md),
 * «Окно, страница или панель»): у неё свой адрес, она переживает «Назад», а короткие
 * действия на ней — окна.
 */
function ClientCard() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<readonly IssuedCredentials[]>([]);

  // Ключ под `clients`: пополнение, смена состояния и минуса сбрасывают его вместе со списком.
  const card = useQuery({
    queryKey: ['clients', 'card', id],
    queryFn: () => findClient(id),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['clients'] });
  };

  const activate = useMutation({
    mutationFn: () =>
      request<unknown>(`/clients/${id}/status`, {
        method: 'PATCH',
        body: { status: 'active' },
      }),
    onSuccess: invalidate,
  });

  // Подтверждаемые действия — своими мутациями: их отказ виден в окне подтверждения
  // и не повторяется на странице.
  const confirmStatus = useMutation({
    mutationFn: (status: ClientStatus) =>
      request<unknown>(`/clients/${id}/status`, {
        method: 'PATCH',
        body: { status },
      }),
    onSuccess: () => atMost(invalidate()),
  });

  const overdraft = useMutation({
    mutationFn: (value: string) =>
      request<unknown>(`/clients/${id}/overdraft`, {
        method: 'PATCH',
        body: { overdraftLimit: value },
      }),
    onSuccess: () => atMost(invalidate()),
  });

  const back = (
    <Link href="/clients" className="text-muted-foreground hover:text-foreground">
      ← Все клиенты
    </Link>
  );

  const loadError = asApiError(card.error);
  if (card.isPending) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p className="text-muted-foreground">Загружаем…</p>
      </div>
    );
  }
  if (card.isError) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        {loadError === undefined ? (
          <p className="text-crit">Карточку не удалось загрузить. Обновите страницу.</p>
        ) : (
          <ErrorNote error={loadError} />
        )}
      </div>
    );
  }
  if (card.data === null) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p>
          Такого клиента нет. Возможно, ссылка неполная или устарела — найдите клиента в списке.
        </p>
      </div>
    );
  }

  const client = card.data;
  const changeError = asApiError(activate.error);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {back}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-lg font-semibold">{client.name}</h2>
          <span className={`rounded-sm px-1.5 py-0.5 ${clientStatusTone(client.status)}`}>
            {CLIENT_STATUS_NAME[client.status]}
          </span>
          <span className="num">
            Остаток{' '}
            {/*
              Отрицательный остаток выделяется, но не паникой: при разрешённом минусе
              это штатное состояние, а не авария (DESIGN.md).
            */}
            <b className={isNegative(client.balance) ? 'text-warn' : undefined}>
              {money(client.balance)}
            </b>
          </span>
          <span className="num text-muted-foreground">заведён {moment(client.created_at)}</span>
        </div>
        {!canChange && <ReadOnly what="клиента, его каналы и деньги" />}
      </div>

      {/*
        Выданный пароль канала — здесь, над разделами, а не в окне заведения: окно
        закрывается успехом, а второго показа пароля не будет. Панелей может быть
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

      <section className="flex flex-col gap-3">
        <StatusChoice
          client={client}
          canChange={canChange}
          busy={activate.isPending || confirmStatus.isPending}
          onActivate={() => {
            activate.mutate();
          }}
          onConfirmStatus={(status) => confirmStatus.mutateAsync(status)}
        />
        {changeError !== undefined && <ErrorNote error={changeError} />}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Деньги</h2>
        <DepositForm client={client} canChange={canChange} />
        {canChange && (
          <OverdraftField client={client} onSave={(value) => overdraft.mutateAsync(value)} />
        )}
      </section>

      <section>
        <ClientChannels
          clientId={client.id}
          onIssued={(secret) => {
            setIssued((list) => [
              ...list,
              { ...secret, title: `${secret.title} — клиент «${client.name}»` },
            ]);
          }}
        />
      </section>

      <section>
        <AccountLedger source={`/clients/${client.id}/entries`} account="client" />
      </section>
    </div>
  );
}

/**
 * Смена состояния клиента.
 *
 * Последствие не косметическое: маршрутизация требует `active` **и от канала, и от клиента**,
 * поэтому любое другое состояние означает «ни один канал не звонит». Разрешение звонить —
 * одним нажатием; остановка и закрытие — через подтверждение с названным последствием
 * ([DESIGN.md](../../../../../../docs/DESIGN.md)): раньше и необратимое «Закрыт» срабатывало
 * с первого нажатия (ui-review, 2026-09-14). Из `closed` вариантов нет вовсе: переход
 * необратим, и предлагать его обратно — обещать то, чего API не сделает.
 */
function StatusChoice({
  client,
  canChange,
  busy,
  onActivate,
  onConfirmStatus,
}: {
  client: ClientRow;
  canChange: boolean;
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
      <h2 className="font-semibold">Состояние</h2>
      <p className="text-muted-foreground">
        Сейчас — {CLIENT_STATUS_NAME[client.status].toLowerCase()}:{' '}
        {CLIENT_STATUS_MEANING[client.status]} Смена попадает в журнал вместе с тем, что было до.
      </p>
      {canChange && (
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
      )}
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
 * Окно с кнопкой, называющей новое значение, и строкой «было → станет», а не отправка
 * по потере фокуса: раньше щелчок мимо поля уже выдавал кредит, в поле стоял машинный
 * `1500.5` вместо `1 500,5 ₽`, а отказ показывался над таблицей, далеко от поля
 * (ui-review, 2026-09-14).
 */
function OverdraftField({
  client,
  onSave,
}: {
  client: ClientRow;
  onSave: (value: string) => Promise<unknown>;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-semibold">Разрешённый минус</h3>
      <p className="text-muted-foreground">
        Сейчас — <span className="num">{money(client.overdraft_limit)}</span>: насколько глубоко
        клиенту разрешено уходить в минус. Ноль — только на свои.
      </p>
      <div>
        <FormDialog
          label="Изменить"
          variant="outline"
          title={`Разрешённый минус: «${client.name}»`}
          description={
            <>
              Сейчас — <span className="num">{money(client.overdraft_limit)}</span>.
            </>
          }
        >
          <OverdraftForm client={client} onSave={onSave} />
        </FormDialog>
      </div>
    </div>
  );
}

function OverdraftForm({
  client,
  onSave,
}: {
  client: ClientRow;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState('');
  const typed = moneyFromInput(value);
  const shown = typed === undefined ? '' : money(typed);

  return (
    <DialogForm
      submitLabel={typed === undefined ? 'Установить' : `Установить ${shown}`}
      canSubmit={typed !== undefined}
      onSubmit={async () => {
        if (typed === undefined) return;
        await onSave(typed);
      }}
    >
      <DialogField label="Новый минус, ₽">
        <Input
          className="num"
          inputMode="decimal"
          autoComplete="off"
          autoFocus
          placeholder="10 000,00"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </DialogField>

      {value !== '' && typed === undefined && (
        <p className="text-warn sm:col-span-2">
          Сумма — число, не больше шести знаков после запятой: например 10 000,50.
        </p>
      )}

      <div className="flex flex-col gap-1 sm:col-span-2" aria-live="polite">
        {typed !== undefined && (
          <p>
            Было: <b className="num">{money(client.overdraft_limit)}</b>. Станет:{' '}
            <b className="num">{shown}</b>.
          </p>
        )}
        <p className="text-muted-foreground">
          Правка действует на новые вызовы сразу и попадает в журнал вместе с прежним значением.
          Уменьшение ниже текущего долга допустимо: это «больше в долг не даём», потраченное при
          этом никуда не девается.
        </p>
      </div>
    </DialogForm>
  );
}
