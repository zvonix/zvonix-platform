'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { SecondFactor } from '@/components/second-factor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { useSession } from '@/lib/session';

interface SessionRow {
  readonly id: string;
  readonly current: boolean;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly last_seen_at: string;
}

const SESSIONS_KEY = ['auth', 'sessions'] as const;
const PASSWORD_MIN = 12;

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/** «Chrome на Windows»: из строки браузера берётся только то, по чему человек узнаёт своё устройство. */
function deviceName(userAgent: string | null): string {
  if (userAgent === null || userAgent === '') return 'Неизвестное устройство';
  const browser = /Edg\//u.test(userAgent)
    ? 'Edge'
    : /OPR\/|Opera/u.test(userAgent)
      ? 'Opera'
      : /YaBrowser/u.test(userAgent)
        ? 'Яндекс Браузер'
        : /Firefox\//u.test(userAgent)
          ? 'Firefox'
          : /Chrome\//u.test(userAgent)
            ? 'Chrome'
            : /Safari\//u.test(userAgent)
              ? 'Safari'
              : 'Браузер';
  const system = /Windows/u.test(userAgent)
    ? 'Windows'
    : /Android/u.test(userAgent)
      ? 'Android'
      : /iPhone|iPad|iOS/u.test(userAgent)
        ? 'iOS'
        : /Mac OS/u.test(userAgent)
          ? 'macOS'
          : /Linux/u.test(userAgent)
            ? 'Linux'
            : null;
  return system === null ? browser : `${browser} на ${system}`;
}

/**
 * Страница «Аккаунт» для любой роли: кто вошёл, смена пароля, где выполнен вход, второй фактор. Клиент и партнёр раньше не
 * могли сменить пароль из кабинета, хотя API давно это умеет. `banner` — то, что нужно сказать выше всего (у администратора:
 * без второго фактора остальные разделы закрыты).
 */
export function AccountView({ staff = false, banner }: { staff?: boolean; banner?: ReactNode }) {
  const session = useSession();
  const user = session.data;

  return (
    <div className="flex max-w-xl flex-col gap-4">
      {banner}
      {user !== undefined && (
        <section className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold">{user.full_name}</h2>
          <span className="text-muted-foreground">{user.email}</span>
        </section>
      )}
      <PasswordForm />
      <Sessions />
      <SecondFactor staff={staff} />
    </div>
  );
}

function PasswordForm() {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState<number | undefined>(undefined);

  const mismatch = again !== '' && again !== next;
  const valid = current !== '' && next.length >= PASSWORD_MIN && next === again;

  const change = useMutation({
    mutationFn: () =>
      request<{ revoked_sessions: number }>('/auth/password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      }),
    onSuccess: async (result) => {
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(result.revoked_sessions);
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });
  const error = asApiError(change.error);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">Пароль</h2>
        <Hint label="Про смену пароля">
          <p>
            Не короче {String(PASSWORD_MIN)} символов. После смены вход на других устройствах
            закроется, а на этом вы останетесь.
          </p>
        </Hint>
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setDone(undefined);
          change.mutate();
        }}
      >
        <Label htmlFor="pw-current">Текущий пароль</Label>
        <Input
          id="pw-current"
          type="password"
          autoComplete="current-password"
          className="max-w-72"
          value={current}
          onChange={(event) => {
            setCurrent(event.target.value);
          }}
        />
        <Label htmlFor="pw-new">Новый пароль</Label>
        <Input
          id="pw-new"
          type="password"
          autoComplete="new-password"
          className="max-w-72"
          value={next}
          onChange={(event) => {
            setNext(event.target.value);
          }}
        />
        <Label htmlFor="pw-again">Новый пароль ещё раз</Label>
        <Input
          id="pw-again"
          type="password"
          autoComplete="new-password"
          className="max-w-72"
          aria-invalid={mismatch}
          value={again}
          onChange={(event) => {
            setAgain(event.target.value);
          }}
        />
        {mismatch && <span className="text-crit">Пароли не совпадают</span>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!valid || change.isPending}>
            {change.isPending ? 'Меняем…' : 'Сменить пароль'}
          </Button>
          {done !== undefined && (
            <span role="status" className="text-ok">
              Пароль сменён
              {done > 0 ? `, на других устройствах вышли: ${String(done)}` : ''}
            </span>
          )}
        </div>
        {error !== undefined && <ErrorNote error={error} />}
      </form>
    </section>
  );
}

function Sessions() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: ({ signal }) => request<{ sessions: SessionRow[] }>('/auth/sessions', { signal }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => request<undefined>(`/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SESSIONS_KEY }),
  });
  const revokeOthers = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await request<undefined>(`/auth/sessions/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SESSIONS_KEY }),
  });

  const sessions = list.data?.sessions ?? [];
  const others = sessions.filter((row) => !row.current);
  const error =
    asApiError(list.error) ?? asApiError(revoke.error) ?? asApiError(revokeOthers.error);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">Где выполнен вход</h2>
        <Hint label="Про входы">
          <p>
            Если видите чужое устройство, закройте его вход и смените пароль. Закрытое устройство
            при следующем действии попросит войти заново.
          </p>
        </Hint>
      </div>
      {error !== undefined && <ErrorNote error={error} />}
      <ul className="flex flex-col divide-y divide-border">
        {sessions.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="flex flex-col">
              <span className="font-medium">
                {deviceName(row.user_agent)}
                {row.current && <span className="ml-2 text-ok">это устройство</span>}
              </span>
              <span className="num text-muted-foreground">
                {row.ip ?? 'адрес неизвестен'} · {moment(row.last_seen_at)}
              </span>
            </span>
            {!row.current && (
              <Button
                variant="outline"
                size="xs"
                disabled={revoke.isPending}
                onClick={() => {
                  revoke.mutate(row.id);
                }}
              >
                Закрыть вход
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <div>
          <Button
            variant="outline"
            disabled={revokeOthers.isPending}
            onClick={() => {
              revokeOthers.mutate(others.map((row) => row.id));
            }}
          >
            Выйти на всех других устройствах
          </Button>
        </div>
      )}
    </section>
  );
}
