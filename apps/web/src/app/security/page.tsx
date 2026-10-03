'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, request } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function SecurityPage() {
  return (
    <ConsoleShell title="Безопасность" requireRole={['admin', 'support']}>
      {() => <SecurityView />}
    </ConsoleShell>
  );
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/** Секрет группами по четыре знака: так его вводят руками без ошибок. */
const grouped = (secret: string): string => secret.match(/.{1,4}/gu)?.join(' ') ?? secret;

/**
 * Второй фактор: код из приложения на телефоне ([ADR-0028](../../../../../docs/adr/0028-vtoroy-faktor.md)).
 * Администратору он может быть обязателен ([ADR-0067](../../../../../docs/adr/0067-vtoroy-faktor-administratoram.md)) —
 * тогда сюда ведут сразу после входа, остальное закрыто.
 */
function SecurityView() {
  const session = useSession();
  const user = session.data;
  const enabled = user?.totp_enabled === true;
  const required = user?.second_factor_required === true;

  return (
    <div className="flex max-w-xl flex-col gap-4">
      {required && (
        <p role="alert" className="rounded-md border border-warn bg-warn-soft p-3 text-warn">
          Администратору нужен второй фактор. Пока он не подключён, остальные разделы закрыты.
        </p>
      )}
      {enabled ? <Enabled /> : <Connect />}
    </div>
  );
}

function Connect() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');

  const start = useMutation({
    mutationFn: () =>
      request<{ secret: string; otpauth_uri: string }>('/auth/totp', { method: 'POST' }),
  });
  const confirm = useMutation({
    mutationFn: () => request<undefined>('/auth/totp/confirm', { method: 'POST', body: { code } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['auth', 'me'] }),
  });

  const enrolment = start.data;
  const startError = asApiError(start.error);
  const confirmError = asApiError(confirm.error);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-semibold">Второй фактор не подключён</h2>

      {enrolment === undefined ? (
        <>
          <p className="text-muted-foreground">
            После пароля при входе будет нужен код из приложения на телефоне (Google Authenticator,
            Яндекс Ключ, Authy и подобные).
          </p>
          <div>
            <Button
              onClick={() => {
                start.mutate();
              }}
              disabled={start.isPending}
            >
              Подключить
            </Button>
          </div>
          {startError !== undefined && <ErrorNote error={startError} />}
        </>
      ) : (
        <>
          <p>В приложении выберите «Добавить вручную» и введите ключ. Показывается один раз.</p>
          <p
            className="num rounded-md bg-muted p-3 text-[15px] tracking-wide"
            data-testid="totp-secret"
          >
            {grouped(enrolment.secret)}
          </p>
          <a
            className="text-primary underline-offset-4 hover:underline"
            href={enrolment.otpauth_uri}
          >
            Открыть в приложении на этом устройстве
          </a>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              confirm.mutate();
            }}
          >
            <Label htmlFor="totp-code">Код из приложения</Label>
            <Input
              id="totp-code"
              className="num max-w-40"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/gu, ''));
              }}
            />
            <div>
              <Button type="submit" disabled={code.length !== 6 || confirm.isPending}>
                Подтвердить и включить
              </Button>
            </div>
            {confirmError !== undefined && <ErrorNote error={confirmError} />}
          </form>
        </>
      )}
    </section>
  );
}

function Enabled() {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [open, setOpen] = useState(false);

  const disable = useMutation({
    mutationFn: () =>
      request<undefined>('/auth/totp', { method: 'DELETE', body: { password, code } }),
    onSuccess: () => {
      setPassword('');
      setCode('');
      setOpen(false);
      return queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
  });

  const disableError = asApiError(disable.error);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-semibold">Второй фактор подключён</h2>
      <p className="text-muted-foreground">
        При входе после пароля спрашивается код из приложения. Потеряли телефон — другой
        администратор сбросит фактор в разделе «Учётные записи».
      </p>
      {!open ? (
        <div>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(true);
            }}
          >
            Отключить
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            disable.mutate();
          }}
        >
          <Label htmlFor="off-password">Пароль</Label>
          <Input
            id="off-password"
            type="password"
            autoComplete="current-password"
            className="max-w-72"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          <Label htmlFor="off-code">Код из приложения</Label>
          <Input
            id="off-code"
            className="num max-w-40"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/gu, ''));
            }}
          />
          <div>
            <Button
              type="submit"
              variant="destructive"
              disabled={password === '' || code.length !== 6 || disable.isPending}
            >
              Отключить второй фактор
            </Button>
          </div>
          {disableError !== undefined && <ErrorNote error={disableError} />}
        </form>
      )}
    </section>
  );
}
