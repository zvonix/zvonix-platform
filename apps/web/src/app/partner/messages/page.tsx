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
  AccountSettingsForm,
  AccountTariffName,
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
              Цена и лимиты — в тарифе: создайте тарифы на странице «Тарифы MAX» и назначьте
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
        <AccountTariffName account={account} />
      </TableCell>

      <TableCell className="num text-right">
        {account.price === null ? (
          <span className="text-faint">не задана</span>
        ) : (
          money(account.price)
        )}
      </TableCell>

      <TableCell className={`num text-right ${account.recommended ? 'text-faint' : ''}`}>
        <span className="block">
          {account.limit_per_minute === null ? '—' : `${String(account.limit_per_minute)} в минуту`}
        </span>
        {account.limit_per_hour !== null && (
          <span className="block text-faint">{`${String(account.limit_per_hour)} в час`}</span>
        )}
        <span className="block text-faint">
          {account.limit_per_day === null ? '—' : `${String(account.limit_per_day)} в сутки`}
        </span>
        {account.recommended && (
          <span className="block whitespace-normal font-sans text-muted-foreground">
            не действуют: рекомендованная работа
          </span>
        )}
        {account.paused_until !== null && (
          <span className="block text-warn">Пауза: много «нет MAX» после отправки</span>
        )}
        {account.warmup_day !== null && (
          <span className="block text-faint">
            Прогрев, {String(account.warmup_day + 1)}-е сутки: сегодня до{' '}
            {String(account.daily_limit_now)}
          </span>
        )}
      </TableCell>

      <TableCell className="text-right">
        <span className="flex flex-wrap justify-end gap-2">
          {needsLogin && (
            <Button variant="outline" size="xs" onClick={onQr}>
              Войти по QR
            </Button>
          )}
          {account.status === 'active' && (
            <FormDialog
              label="Тест"
              title={`Пробное сообщение через «${account.label}»`}
              description="Бесплатно, до семи в сутки на аккаунт. Уходит именно через этот аккаунт."
              variant="outline"
              size="xs"
            >
              <TestMessageForm account={account} />
            </FormDialog>
          )}
          <FormDialog
            label="Настройки"
            title={`Аккаунт «${account.label}»`}
            variant="outline"
            size="xs"
          >
            <AccountSettingsForm account={account} />
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
 * Пробное сообщение: проверить, что вошедший аккаунт действительно отправляет. Результат показывается в окне, оно не
 * закрывается — можно отправить ещё. Деньги не списываются, в журнал сообщений пробное не попадает.
 */
function TestMessageForm({ account }: { account: Account }) {
  const [recipient, setRecipient] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<number | undefined>(undefined);

  return (
    <DialogForm
      submitLabel="Отправить"
      canSubmit={recipient.trim() !== ''}
      keepOpen
      onSubmit={async () => {
        setResult(undefined);
        const answer = await request<{ sent: true; remaining: number }>(
          `/partner/messenger/accounts/${account.id}/test`,
          {
            method: 'POST',
            body: {
              recipient: recipient.trim(),
              ...(text.trim() === '' ? {} : { text: text.trim() }),
            },
          },
        );
        setResult(answer.remaining);
      }}
    >
      <DialogField
        label="Номер получателя"
        wide
        hint="Одиннадцать цифр: 79131234567. У номера должен быть MAX."
      >
        <Input
          autoFocus
          inputMode="tel"
          autoComplete="off"
          placeholder="79131234567"
          value={recipient}
          onChange={(event) => {
            setRecipient(event.target.value);
          }}
        />
      </DialogField>
      <DialogField label="Текст" wide hint="Пусто — уйдёт «Проверка связи Zvonix».">
        <Input
          maxLength={200}
          autoComplete="off"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </DialogField>
      {result !== undefined && (
        <p role="status" className="text-ok sm:col-span-2">
          Отправлено. Пробных на сегодня осталось: {String(result)}.
        </p>
      )}
    </DialogForm>
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

/** Сколько ждём QR, прежде чем назвать причину: запуск нового аккаунта у провайдера занимает до минуты. */
const QR_PATIENCE_MS = 90_000;

/** Почему QR не появился — по коду ответа сервиса сообщений, без имени провайдера. */
function stallReason(failure: ApiError): string {
  const raw = failure.details['provider_status'];
  const status = typeof raw === 'number' ? raw : undefined;
  if (failure.details['provider_reason'] === 'timeout')
    return 'Сервис сообщений не ответил вовремя.';
  if (status === 401 || status === 403) return 'Сервис сообщений не принял ключ аккаунта.';
  if (status === 404) return 'В сервисе сообщений нет такого аккаунта.';
  if (status === 429) return 'Сервис сообщений просит подождать: слишком много запросов.';
  if (status !== undefined && status >= 500) {
    return `Сервис сообщений не отвечает (код ${String(status)}).`;
  }
  return 'Сервис сообщений не отвечает.';
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

  const [lastFailure, setLastFailure] = useState<ApiError | undefined>(undefined);
  useEffect(() => {
    if (qr.error instanceof ApiError) setLastFailure(qr.error);
    else if (qr.data !== undefined) setLastFailure(undefined);
  }, [qr.error, qr.data]);
  const failure =
    qr.data === undefined
      ? (lastFailure ?? (qr.error instanceof ApiError ? qr.error : undefined))
      : undefined;
  // Новый аккаунт у провайдера запускается до минуты и первое время отвечает «недоступен»: это ожидание,
  // а не ошибка. Красным показывается только то, что само не пройдёт — и «недоступен» дольше полутора минут.
  const [openedAt] = useState(() => Date.now());
  const unavailable = failure !== undefined && failure.code === 'dependency_unavailable';
  const stalled = unavailable && Date.now() - openedAt > QR_PATIENCE_MS;
  const error = unavailable ? undefined : failure;
  const status = qr.data?.status;
  const waiting =
    error === undefined &&
    !stalled &&
    status !== 'qr' &&
    status !== 'authorized' &&
    status !== 'password';

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
        {stalled && (
          <p role="alert" className="text-center text-warn">
            {stallReason(failure)} Попробуйте закрыть окно и открыть его снова позже; если не
            проходит — сообщите администратору площадки.
          </p>
        )}
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
            Код обновляется сам. Если в MAX включён облачный пароль, после сканирования введите его
            здесь.
          </p>
        )}
      </div>
    </FormDialog>
  );
}
