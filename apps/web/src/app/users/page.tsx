'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { USER_ROLES, USER_STATUSES, type UserRole, type UserStatus } from '@zvonix/shared';
import { Suspense, useState } from 'react';
import { Choice } from '@/components/choice';
import { ConsoleShell } from '@/components/console-shell';
import { FilterInput } from '@/components/filter-input';
import { PageNav } from '@/components/page-nav';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReadOnly } from '@/components/read-only';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { isFuture, moment } from '@/lib/format';
import { ROLE_NAME, STATUS_MEANING, STATUS_NAME, statusTone } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';

const PAGE_SIZE = 50;

/** Столько же колонок у раскрытой строки: без этого подтверждение схлопывается в первую. */
const COLUMNS = 9;

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly full_name: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly created_at: string;
  readonly email_confirmed_at: string | null;
  readonly totp_enabled: boolean;
  readonly last_login_at: string | null;
  readonly locked_until: string | null;
}

export default function UsersPage() {
  return (
    <ConsoleShell title="Учётные записи" requireRole={['admin', 'support']}>
      {() => (
        // `useSearchParams` читает адрес уже в браузере, и без границы ожидания
        // страница не соберётся статически.
        <Suspense fallback={<p className="text-muted-foreground">Загружаем…</p>}>
          <UsersTable />
        </Suspense>
      )}
    </ConsoleShell>
  );
}

function UsersTable() {
  const canChange = useCanChange();
  const url = useUrlState();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | undefined>(undefined);

  const offset = Number.parseInt(url.get('offset'), 10) || 0;
  const search = new URLSearchParams(url.query);
  search.set('limit', String(PAGE_SIZE));

  const list = useQuery({
    queryKey: ['users', search.toString()],
    queryFn: () => request<{ users: UserRow[]; total: number }>(`/users?${search.toString()}`),
  });

  const change = useMutation({
    mutationFn: (input: { id: string; status: UserStatus }) =>
      request<unknown>(`/users/${input.id}/status`, {
        method: 'PATCH',
        body: { status: input.status },
      }),
    onSuccess: async () => {
      setEditing(undefined);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const error = change.error instanceof ApiError ? change.error : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Адрес почты</span>
          <FilterInput
            className="w-[220px]"
            placeholder="часть адреса"
            value={url.get('email')}
            onChange={(email) => {
              url.set({ email, offset: '' });
            }}
          />
        </label>

        <Choice
          label="Роль"
          anyLabel="любая"
          value={url.get('role')}
          options={USER_ROLES.map((role) => [role, ROLE_NAME[role]])}
          onChange={(value) => {
            url.set({ role: value, offset: '' });
          }}
        />

        <Choice
          label="Состояние"
          anyLabel="любое"
          value={url.get('status')}
          options={USER_STATUSES.map((status) => [status, STATUS_NAME[status]])}
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

      {!canChange && <ReadOnly what="состояние учётных записей" />}

      {error !== undefined && (
        <p role="alert" className="text-crit">
          {error.message}
        </p>
      )}

      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Адрес</TableHead>
              <TableHead className="h-8">Имя</TableHead>
              <TableHead className="h-8">Роль</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8">Адрес подтверждён</TableHead>
              <TableHead className="h-8">Второй фактор</TableHead>
              <TableHead className="h-8">Последний вход</TableHead>
              <TableHead className="h-8">Заведена</TableHead>
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

            {list.data?.users.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="text-muted-foreground">
                  По этому отбору записей нет.
                </TableCell>
              </TableRow>
            )}

            {list.data?.users.map((user) => (
              <RowGroup
                key={user.id}
                user={user}
                canChange={canChange}
                open={editing === user.id}
                busy={change.isPending}
                onToggle={() => {
                  setEditing(editing === user.id ? undefined : user.id);
                }}
                onChoose={(status) => {
                  change.mutate({ id: user.id, status });
                }}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function RowGroup({
  user,
  canChange,
  open,
  busy,
  onToggle,
  onChoose,
}: {
  user: UserRow;
  canChange: boolean;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onChoose: (status: UserStatus) => void;
}) {
  const locked = isFuture(user.locked_until);

  return (
    <>
      <TableRow>
        <TableCell>
          <span className="num">{user.email}</span>
          {locked && (
            <span className="ml-2 rounded-sm bg-crit-soft px-1 text-crit">
              вход закрыт до {moment(user.locked_until)}
            </span>
          )}
        </TableCell>
        <TableCell>{user.full_name}</TableCell>
        <TableCell>{ROLE_NAME[user.role]}</TableCell>
        <TableCell>
          <span className={`rounded-sm px-1.5 py-0.5 ${statusTone(user.status)}`}>
            {STATUS_NAME[user.status]}
          </span>
        </TableCell>
        <TableCell>
          {user.email_confirmed_at === null ? (
            <span className="text-warn">нет</span>
          ) : (
            <span className="num text-muted-foreground">{moment(user.email_confirmed_at)}</span>
          )}
        </TableCell>
        <TableCell>
          {user.totp_enabled ? 'включён' : <span className="text-muted-foreground">нет</span>}
        </TableCell>
        <TableCell>
          <span className="num text-muted-foreground">{moment(user.last_login_at)}</span>
        </TableCell>
        <TableCell>
          <span className="num text-muted-foreground">{moment(user.created_at)}</span>
        </TableCell>
        <TableCell>
          {canChange && (
            <Button variant="outline" size="sm" onClick={onToggle} aria-expanded={open}>
              {open ? 'Отменить' : 'Изменить'}
            </Button>
          )}
        </TableCell>
      </TableRow>

      {open && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={COLUMNS} className="whitespace-normal">
            {/*
              Подтверждение называет последствие, а не спрашивает «вы уверены?»
              (DESIGN.md). Здесь последствие денежное по сути: снятие активности
              закрывает все сессии, и партнёр перестаёт принимать вызовы немедленно.
            */}
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">
                Новое состояние для <span className="num">{user.email}</span>. Действие попадает в
                журнал вместе с тем, что было до.
              </p>
              <div className="flex flex-wrap gap-2">
                {USER_STATUSES.filter((status) => status !== user.status).map((status) => (
                  <button
                    key={status}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      onChoose(status);
                    }}
                    className="max-w-[280px] rounded-md border border-border bg-card p-2 text-left hover:border-ring disabled:opacity-50"
                  >
                    <span className="font-medium">{STATUS_NAME[status]}</span>
                    <span className="block text-muted-foreground">{STATUS_MEANING[status]}</span>
                  </button>
                ))}
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
