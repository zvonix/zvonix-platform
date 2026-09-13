'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { OneTimeSecret } from '@/components/one-time-secret';
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
import { moment } from '@/lib/format';

const COLUMNS = 5;

interface ApiKey {
  readonly id: string;
  readonly key_id: string;
  readonly label: string;
  readonly allowed_ips: readonly string[];
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

interface IssuedKey {
  readonly id: string;
  readonly key_id: string;
  readonly secret: string;
  readonly expires_at: string | null;
}

/** Выпущенный ключ вместе с назначением: список к этому моменту ещё не обновился. */
interface IssuedWithLabel {
  readonly key: IssuedKey;
  readonly label: string;
}

export default function MyIntegrationPage() {
  return (
    <ConsoleShell title="Интеграция" requireRole="client">
      {() => <Integration />}
    </ConsoleShell>
  );
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

function Integration() {
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<IssuedWithLabel | undefined>(undefined);

  const keys = useQuery({
    queryKey: ['my', 'api-keys'],
    queryFn: () => request<{ keys: ApiKey[] }>('/client/api-keys'),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['my', 'api-keys'] });
  };

  if (keys.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {keys.error.message}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[720px] text-muted-foreground">
        Ключ открывает вашей диспетчерской доступ к <span className="num">/v1</span>: состояние
        вызовов и баланс. Предъявляется схемой Basic — имя пользователя это{' '}
        <span className="num">zvx_client_…</span>, пароль — секрет. По ключу на систему: сорвавшийся
        ключ отзывается отдельно от остальных.
      </p>

      {issued !== undefined && (
        <OneTimeSecret
          title={`Ключ «${issued.label}»`}
          onClose={() => {
            setIssued(undefined);
          }}
        >
          <p>
            Секрет показывается <b>один раз</b> — в базе его нет, только хеш. Перепишите его сейчас:
            восстановить будет нечем, останется только завести новый ключ и отозвать этот.
          </p>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Имя</dt>
            <dd className="num select-all">{issued.key.key_id}</dd>
            <dt className="text-muted-foreground">Секрет</dt>
            <dd className="num select-all break-all">{issued.key.secret}</dd>
            {issued.key.expires_at !== null && (
              <>
                <dt className="text-muted-foreground">Действует до</dt>
                <dd className="num">{moment(issued.key.expires_at)}</dd>
              </>
            )}
          </dl>
        </OneTimeSecret>
      )}

      <AddKey
        onIssued={async (key, label) => {
          setIssued({ key, label });
          await refresh();
        }}
      />

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Назначение</TableHead>
              <TableHead className="h-8">Имя</TableHead>
              <TableHead className="h-8">Адреса</TableHead>
              <TableHead className="h-8">Обращались</TableHead>
              <TableHead className="h-8 text-right">Действие</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  Загружаем…
                </TableCell>
              </TableRow>
            )}

            {keys.data?.keys.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="whitespace-normal text-muted-foreground">
                  Ключей нет. Пока их нет, звонить можно только софтфоном: доступа к{' '}
                  <span className="num">/v1</span> у вашей системы не будет.
                </TableCell>
              </TableRow>
            )}

            {keys.data?.keys.map((key) => (
              <TableRow key={key.id} className={key.revoked_at === null ? '' : 'opacity-60'}>
                <TableCell className="whitespace-normal">{key.label}</TableCell>
                <TableCell className="num select-all">{key.key_id}</TableCell>
                <TableCell className="num whitespace-normal">
                  {key.allowed_ips.length === 0 ? (
                    <span className="text-muted-foreground">откуда угодно</span>
                  ) : (
                    key.allowed_ips.join(', ')
                  )}
                </TableCell>
                <TableCell className="num text-muted-foreground">
                  {key.last_used_at === null ? 'ни разу' : moment(key.last_used_at)}
                </TableCell>
                <TableCell className="text-right">
                  {key.revoked_at === null ? (
                    <RevokeKey id={key.id} onRevoked={refresh} />
                  ) : (
                    <span className="text-muted-foreground">отозван {moment(key.revoked_at)}</span>
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

/**
 * Заведение ключа.
 *
 * Список адресов необязателен: диспетчерская может стоять за меняющимся адресом,
 * и пустой список — выбор клиента, а не недосмотр. Заполненный при этом сильнее всего
 * прочего: украденный ключ вне этих адресов бесполезен.
 */
function AddKey({ onIssued }: { onIssued: (key: IssuedKey, label: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [ips, setIps] = useState('');

  const add = useMutation({
    mutationFn: () =>
      request<{ key: IssuedKey }>('/client/api-keys', {
        method: 'POST',
        body: {
          label,
          allowedIps: ips
            .split(/[\s,]+/u)
            .map((value) => value.trim())
            .filter((value) => value !== ''),
        },
      }),
    onSuccess: async (created) => {
      const issuedFor = label;
      setLabel('');
      setIps('');
      setOpen(false);
      await onIssued(created.key, issuedFor);
    },
  });

  const error = asApiError(add.error);

  if (!open) {
    return (
      <div>
        <Button
          size="sm"
          onClick={() => {
            setOpen(true);
          }}
        >
          Завести ключ
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex max-w-[720px] flex-col gap-2 rounded-lg border border-border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (label.trim() !== '') add.mutate();
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Назначение</span>
          <Input
            className="w-[260px]"
            value={label}
            placeholder="Диспетчерская, основной сервер"
            onChange={(event) => {
              setLabel(event.target.value);
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Адреса, откуда принимать</span>
          <Input
            className="num w-[280px]"
            value={ips}
            placeholder="необязательно: 203.0.113.7"
            onChange={(event) => {
              setIps(event.target.value);
            }}
          />
        </label>
        <Button type="submit" size="sm" disabled={add.isPending}>
          Завести
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(false);
          }}
        >
          Отмена
        </Button>
      </div>

      <p className="text-muted-foreground">
        Адреса перечисляются через запятую. Пустое поле означает «откуда угодно» — это допустимо, но
        заполненный список остаётся единственной защитой на случай, если ключ утечёт.
      </p>

      {error !== undefined && <ErrorNote error={error} />}
    </form>
  );
}

/** Отзыв необратим: первый нажим спрашивает, второй делает. */
function RevokeKey({ id, onRevoked }: { id: string; onRevoked: () => Promise<void> }) {
  const [asked, setAsked] = useState(false);

  const revoke = useMutation({
    mutationFn: () => request<unknown>(`/client/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: onRevoked,
  });

  const error = asApiError(revoke.error);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={revoke.isPending}
        className={asked ? 'text-crit' : ''}
        onClick={() => {
          if (asked) {
            revoke.mutate();
            setAsked(false);
          } else {
            setAsked(true);
          }
        }}
      >
        {asked ? 'Точно отозвать?' : 'Отозвать'}
      </Button>
      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}
