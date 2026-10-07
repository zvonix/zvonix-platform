'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { MessengerAccountStatus } from '@/components/messenger-status';
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
import {} from '@/lib/labels';
import { money } from '@/lib/money';
import {
  ACCOUNTS_KEY,
  AccountTariffSelect,
  RenameForm,
  useMessengerAccounts,
  type Account,
} from './terms';

interface QrResponse {
  readonly status: 'qr' | 'authorized' | 'password' | 'unavailable';
  readonly image?: string;
}

export default function PartnerMessagesPage() {
  return (
    <ConsoleShell title="Аккаунты MAX" cabinet="partner">
      {() => <Accounts />}
    </ConsoleShell>
  );
}

function Accounts() {
  const queryClient = useQueryClient();
  const [qrFor, setQrFor] = useState<Account | undefined>(undefined);

  const list = useMessengerAccounts();

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
              Цена и лимиты — в тарифе: создайте тарифы на странице «Мои тарифы» и назначьте
              аккаунтам здесь. Без своего тарифа аккаунт идёт за тарифом по умолчанию.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="text-muted-foreground hover:bg-transparent">
                  <TableHead className="h-8">Аккаунт</TableHead>
                  <TableHead className="h-8">Состояние</TableHead>
                  <TableHead className="h-8">Тариф</TableHead>
                  <TableHead className="h-8 text-right">Цена за сообщение</TableHead>
                  <TableHead className="h-8 text-right">Лимиты</TableHead>
                  <TableHead className="h-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data?.accounts.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={6} className="whitespace-normal text-muted-foreground">
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
        <MessengerAccountStatus status={account.status} reason={account.state_reason} />
        {account.price === null && account.status === 'active' && (
          <span className="block pt-0.5 text-warn">
            Создайте тариф — без него сообщения не идут
          </span>
        )}
      </TableCell>

      <TableCell>
        <AccountTariffSelect account={account} />
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
            label="Название"
            title={`Аккаунт «${account.label}»`}
            variant="outline"
            size="xs"
          >
            <RenameForm account={account} />
          </FormDialog>
          <ConfirmAction
            label="Удалить"
            title={`Удалить аккаунт «${account.label}»`}
            consequence={
              <p>
                Аккаунт перестанет принимать сообщения и будет удалён вместе с подключением к
                площадке. Вернуть нельзя — только добавить новый и снова войти по QR-коду.
              </p>
            }
            confirmLabel="Удалить"
            size="xs"
            onConfirm={onRetire}
          />
        </span>
      </TableCell>
    </TableRow>
  );
}

/**
 * Облачный пароль MAX: QR отсканирован, но на аккаунте включён пароль для входа. Пароль уходит в MAX через
 * площадку одним запросом и нигде не сохраняется; можно и не вводить его — отключить пароль в MAX и войти заново.
 */
function PasswordForm({ accountId, onSent }: { accountId: string; onSent: () => void }) {
  const [password, setPassword] = useState('');
  const send = useMutation({
    mutationFn: () =>
      request<undefined>(`/partner/messenger/accounts/${accountId}/password`, {
        method: 'POST',
        body: { password },
      }),
    onSuccess: () => {
      setPassword('');
      onSent();
    },
  });
  const error = send.error instanceof ApiError ? send.error : undefined;

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (password !== '' && !send.isPending) send.mutate();
      }}
    >
      <p role="status" className="text-center">
        QR принят. В вашем MAX включён облачный пароль — введите его, чтобы завершить вход.
      </p>
      <Input
        type="password"
        autoComplete="off"
        autoFocus
        aria-label="Облачный пароль MAX"
        placeholder="Облачный пароль MAX"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
        }}
      />
      {error !== undefined && <ErrorNote error={error} />}
      <Button type="submit" disabled={password === '' || send.isPending}>
        {send.isPending ? 'Проверяем…' : 'Войти'}
      </Button>
      <p className="text-center text-muted-foreground">
        Пароль передаётся в MAX и у нас не сохраняется. Не хотите вводить — отключите облачный
        пароль в настройках MAX и отсканируйте QR заново.
      </p>
    </form>
  );
}

/** QR-код входа: обновляется раз в три секунды, пока человек не отсканирует, потом закрывается. */
function QrDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const qr = useQuery({
    queryKey: [...ACCOUNTS_KEY, account.id, 'qr'],
    queryFn: ({ signal }) =>
      request<QrResponse>(`/partner/messenger/accounts/${account.id}/qr`, { signal }),
    refetchInterval: (query) => (query.state.data?.status === 'authorized' ? false : 3_000),
    // Повторяет сам интервал: у только что созданного аккаунта первые ответы — «ещё запускается».
    retry: false,
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

  const failure = qr.error instanceof ApiError ? qr.error : undefined;
  // Новый аккаунт у провайдера запускается до минуты и первое время отвечает «недоступен»: это ожидание,
  // а не ошибка. Красным показывается только то, что само не пройдёт.
  const starting = failure !== undefined && failure.code === 'dependency_unavailable';
  const error = starting ? undefined : failure;
  const status = qr.data?.status;
  const waiting =
    error === undefined && status !== 'qr' && status !== 'authorized' && status !== 'password';

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
        {waiting && (
          // Одна надпись на всё ожидание: запуск аккаунта, пустой ответ, повторный запрос — человеку это одно и то же.
          <p role="status" className="text-muted-foreground">
            Ждём QR-код — новый аккаунт запускается, это может занять до минуты…
          </p>
        )}
        {qr.data?.status === 'qr' && qr.data.image !== undefined && (
          // Картинка — готовая ссылка `data:`: внешнего адреса здесь нет.
          <img
            src={qr.data.image}
            alt="QR-код для входа в MAX"
            className="size-56 rounded-md bg-white p-2"
          />
        )}
        {qr.data?.status === 'password' && (
          <PasswordForm
            accountId={account.id}
            onSent={() => {
              void qr.refetch();
            }}
          />
        )}
        {authorized && (
          <p role="status" className="text-ok">
            Готово: аккаунт вошёл в MAX.
          </p>
        )}
        {!authorized && qr.data?.status !== 'password' && (
          <p className="text-center text-muted-foreground">
            Код обновляется сам. В приложении MAX отключите пароль для входа, если он включён.
          </p>
        )}
      </div>
    </FormDialog>
  );
}
