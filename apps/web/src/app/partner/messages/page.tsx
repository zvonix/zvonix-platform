'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
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
import { ApiError, request } from '@/lib/api';
import {
  MESSENGER_ACCOUNT_STATUS_MEANING,
  MESSENGER_ACCOUNT_STATUS_NAME,
  messengerAccountTone,
} from '@/lib/labels';
import { money, moneyFromInput, numberFromInput } from '@/lib/money';

interface Account {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly phone: string | null;
  readonly price: string | null;
  readonly limit_per_minute: number | null;
  readonly limit_per_day: number | null;
}

interface AccountsResponse {
  readonly enabled: boolean;
  readonly accounts: Account[];
}

interface QrResponse {
  readonly status: 'qr' | 'authorized' | 'unavailable';
  readonly image?: string;
}

const ACCOUNTS_KEY = ['partner', 'messenger', 'accounts'] as const;

export default function PartnerMessagesPage() {
  return (
    <ConsoleShell title="Сообщения MAX" cabinet="partner">
      {() => <Accounts />}
    </ConsoleShell>
  );
}

function Accounts() {
  const queryClient = useQueryClient();
  const [qrFor, setQrFor] = useState<Account | undefined>(undefined);

  const list = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: ({ signal }) => request<AccountsResponse>('/partner/messenger/accounts', { signal }),
    // Состояние аккаунта сверяет площадка раз в минуту: чаще спрашивать нечего.
    refetchInterval: 30_000,
  });

  const create = useMutation({
    mutationFn: (label: string) =>
      request<{ account: Account }>('/partner/messenger/accounts', {
        method: 'POST',
        body: { label },
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      // Заведён — сразу к входу: следующий шаг один, и другого нет.
      setQrFor(created.account);
    },
  });

  const retire = useMutation({
    mutationFn: (id: string) =>
      request<undefined>(`/partner/messenger/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  });

  const error = list.error instanceof ApiError ? list.error : undefined;
  const enabled = list.data?.enabled === true;

  return (
    <div className="flex flex-col gap-4">
      {error !== undefined && <ErrorNote error={error} />}
      {list.isPending && <p className="text-muted-foreground">Загружаем…</p>}

      {list.data !== undefined && !enabled && (
        <p className="rounded-md border border-border bg-card p-3 text-muted-foreground">
          Раздел пока закрыт: сообщения MAX подключает администратор площадки.
        </p>
      )}

      {enabled && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <FormDialog
              label="Добавить аккаунт"
              title="Новый аккаунт MAX"
              description="После добавления откроется QR-код: отсканируйте его в приложении MAX на телефоне."
            >
              <NewAccountForm onCreate={(label) => create.mutateAsync(label)} />
            </FormDialog>
            <p className="text-muted-foreground">
              Цену за одно сообщение и лимиты задаёте вы. Клиентам цена показывается с наценкой
              площадки.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="text-muted-foreground hover:bg-transparent">
                  <TableHead className="h-8">Аккаунт</TableHead>
                  <TableHead className="h-8">Состояние</TableHead>
                  <TableHead className="h-8 text-right">Цена за сообщение</TableHead>
                  <TableHead className="h-8 text-right">Лимиты</TableHead>
                  <TableHead className="h-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data?.accounts.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="whitespace-normal text-muted-foreground">
                      Аккаунтов пока нет. Добавьте первый и войдите в него по QR-коду.
                    </TableCell>
                  </TableRow>
                )}
                {list.data?.accounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    onQr={() => {
                      setQrFor(account);
                    }}
                    onRetire={() => retire.mutateAsync(account.id)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {qrFor !== undefined && (
        <QrDialog
          account={qrFor}
          onClose={() => {
            setQrFor(undefined);
            void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
          }}
        />
      )}
    </div>
  );
}

function NewAccountForm({ onCreate }: { onCreate: (label: string) => Promise<unknown> }) {
  const [label, setLabel] = useState('');
  const trimmed = label.trim();

  return (
    <DialogForm
      submitLabel="Добавить"
      canSubmit={trimmed.length >= 2}
      onSubmit={() => onCreate(trimmed)}
    >
      <DialogField
        label="Название"
        wide
        hint="Как вы называете аккаунт у себя. Клиентам оно не видно."
      >
        <Input
          autoFocus
          autoComplete="off"
          placeholder="Основной"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />
      </DialogField>
    </DialogForm>
  );
}

function AccountRow({
  account,
  onQr,
  onRetire,
}: {
  account: Account;
  onQr: () => void;
  onRetire: () => Promise<unknown>;
}) {
  const needsLogin = account.status === 'pending' || account.status === 'unavailable';

  return (
    <TableRow>
      <TableCell>
        {account.label}
        <span className="num block text-faint">
          {account.phone ?? 'номер появится после входа'}
        </span>
      </TableCell>

      <TableCell className="whitespace-normal">
        <span
          className={`rounded-md px-2 py-0.5 ${messengerAccountTone(account.status)}`}
          title={MESSENGER_ACCOUNT_STATUS_MEANING[account.status]}
        >
          {MESSENGER_ACCOUNT_STATUS_NAME[account.status] ?? account.status}
        </span>
        {account.price === null && account.status === 'active' && (
          <span className="block pt-0.5 text-warn">Задайте цену — без неё сообщения не идут</span>
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
        <span className="block">
          {account.limit_per_minute === null ? '—' : `${String(account.limit_per_minute)} в минуту`}
        </span>
        <span className="block text-faint">
          {account.limit_per_day === null ? '—' : `${String(account.limit_per_day)} в сутки`}
        </span>
      </TableCell>

      <TableCell className="text-right">
        <span className="flex flex-wrap justify-end gap-2">
          {needsLogin && (
            <Button variant="outline" size="xs" onClick={onQr}>
              Войти по QR
            </Button>
          )}
          <FormDialog
            label="Условия"
            title={`Условия: ${account.label}`}
            variant="outline"
            size="xs"
          >
            <TermsForm account={account} />
          </FormDialog>
          <ConfirmAction
            label="Списать"
            title={`Списать аккаунт «${account.label}»`}
            consequence={
              <p>
                Аккаунт перестанет принимать сообщения, его подключение к площадке будет удалено.
                Вернуть нельзя — только добавить новый и снова войти по QR-коду.
              </p>
            }
            confirmLabel="Списать"
            size="xs"
            onConfirm={onRetire}
          />
        </span>
      </TableCell>
    </TableRow>
  );
}

function TermsForm({ account }: { account: Account }) {
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

/** QR-код входа: обновляется раз в пять секунд, пока человек не отсканирует, потом закрывается. */
function QrDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const qr = useQuery({
    queryKey: [...ACCOUNTS_KEY, account.id, 'qr'],
    queryFn: ({ signal }) =>
      request<QrResponse>(`/partner/messenger/accounts/${account.id}/qr`, { signal }),
    refetchInterval: (query) => (query.state.data?.status === 'authorized' ? false : 5_000),
    gcTime: 0,
  });

  const authorized = qr.data?.status === 'authorized';
  useEffect(() => {
    if (!authorized) return;
    const timer = setTimeout(onClose, 1500);
    return () => {
      clearTimeout(timer);
    };
  }, [authorized, onClose]);

  const error = qr.error instanceof ApiError ? qr.error : undefined;

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Вход в MAX: ${account.label}`}
      description="Откройте MAX на телефоне → Профиль → Устройства → Войти по QR-коду и наведите камеру."
    >
      <div className="flex flex-col items-center gap-3 px-5 pb-5">
        {error !== undefined && <ErrorNote error={error} />}
        {qr.isPending && <p className="text-muted-foreground">Получаем QR-код…</p>}
        {qr.data?.status === 'qr' && qr.data.image !== undefined && (
          // Картинка — готовая ссылка `data:`: внешнего адреса здесь нет.
          <img
            src={qr.data.image}
            alt="QR-код для входа в MAX"
            className="size-56 rounded-md bg-white p-2"
          />
        )}
        {qr.data?.status === 'unavailable' && (
          <p className="text-muted-foreground">QR-код пока не готов — повторяем…</p>
        )}
        {authorized && (
          <p role="status" className="text-ok">
            Готово: аккаунт вошёл в MAX.
          </p>
        )}
        {!authorized && (
          <p className="text-center text-muted-foreground">
            Код обновляется сам. В приложении MAX отключите пароль для входа, если он включён.
          </p>
        )}
      </div>
    </FormDialog>
  );
}
