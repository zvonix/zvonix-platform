'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isStaffRole,
  USER_ROLES,
  USER_STATUSES,
  type UserRole,
  type UserStatus,
} from '@zvonix/shared';
import { Suspense, useState } from 'react';
import { Choice } from '@/components/choice';
import { ConfirmAction } from '@/components/confirm-action';
import { ConfirmEmailButton } from '@/components/confirm-email-button';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { FilterInput } from '@/components/filter-input';
import { FormDialog } from '@/components/form-dialog';
import { PageNav } from '@/components/page-nav';
import { SavedFilters, useColumnPicker } from '@/components/table-view';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog';
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
import { atMost } from '@/lib/wait';
import { isFuture, moment } from '@/lib/format';
import { ROLE_NAME, STATUS_MEANING, STATUS_NAME, statusTone } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { useUrlState } from '@/lib/url-state';

const PAGE_SIZE = 50;

/** Столько колонок у строк-сообщений «загружаем» и «записей нет». */
const COLUMNS = 9;

/** Кнопка называет действие, а не состояние, в которое переводит. */
const USER_ACTION: Record<UserStatus, string> = {
  pending: 'Вернуть в заявки',
  active: 'Открыть вход',
  suspended: 'Приостановить',
  disabled: 'Закрыть навсегда',
};

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

interface Owner {
  readonly user_id: string;
  readonly client: { readonly name: string } | null;
  readonly partner: { readonly name: string } | null;
}

/**
 * Кем работает участник: «Клиент «Корона»», «Партнёр «Иван»», оба сразу или «без кабинета»
 * (заявка ещё не одобрена). Сотрудник остаётся своей ролью.
 */
function roleOf(user: UserRow, owner: Owner | undefined): string {
  if (user.role !== 'member') return ROLE_NAME[user.role];
  if (owner === undefined) return ROLE_NAME[user.role];
  const parts = [
    owner.client === null ? undefined : `Клиент «${owner.client.name}»`,
    owner.partner === null ? undefined : `Партнёр «${owner.partner.name}»`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? 'Без кабинета' : parts.join(' и ');
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

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
  // Запрос общий с оболочкой кабинета: второго обращения к `/auth/me` не будет.
  const selfId = useSession().data?.id;
  const url = useUrlState();
  const columns = useColumnPicker('users');

  const offset = Number.parseInt(url.get('offset'), 10) || 0;
  const search = new URLSearchParams(url.query);
  search.set('limit', String(PAGE_SIZE));

  const list = useQuery({
    queryKey: ['users', search.toString()],
    queryFn: () => request<{ users: UserRow[]; total: number }>(`/users?${search.toString()}`),
  });

  const listError = asApiError(list.error);

  const ids = (list.data?.users ?? [])
    .filter((user) => user.role === 'member')
    .map((user) => user.id);
  const owners = useQuery({
    queryKey: ['users', 'owners', ids.join(',')],
    queryFn: () => request<{ owners: Owner[] }>(`/cabinets/owners?userIds=${ids.join(',')}`),
    enabled: ids.length > 0,
  });
  const ownerOf = (user: UserRow): Owner | undefined =>
    owners.data?.owners.find((owner) => owner.user_id === user.id);

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

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SavedFilters />
          {columns.picker}
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

      {listError !== undefined && <ErrorNote error={listError} />}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table {...columns.tableProps}>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Адрес</TableHead>
              <TableHead className="h-8">Имя</TableHead>
              <TableHead className="h-8">Роль</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8">Адрес подтверждён</TableHead>
              <TableHead className="h-8">Второй фактор</TableHead>
              <TableHead className="h-8">Последний вход</TableHead>
              <TableHead className="h-8">Создана</TableHead>
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
                role={roleOf(user, ownerOf(user))}
                self={user.id === selfId}
                canChange={canChange}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * Строка учётной записи; «Изменить» открывает окно выбора нового состояния.
 *
 * **Свою запись администратор не меняет** — API отвечает на это отказом: одно неверное
 * нажатие закрыло бы все его сессии, а вернуть его мог бы только другой администратор.
 * **Закрытая запись окончательна** — вариантов у неё нет вовсе. Открытие входа —
 * одним нажатием, всё, что вход закрывает, — через подтверждение с последствием
 * (ui-review, 2026-09-14).
 */
function RowGroup({
  user,
  role,
  self,
  canChange,
}: {
  user: UserRow;
  role: string;
  self: boolean;
  canChange: boolean;
}) {
  const [open, setOpen] = useState(false);
  const locked = isFuture(user.locked_until);
  const changeable = canChange && !self && user.status !== 'disabled';

  return (
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
      <TableCell>
        {/* Название карточки бывает любой длины: без предела оно растягивало таблицу. */}
        <span className="block max-w-[200px] truncate" title={role}>
          {role}
        </span>
      </TableCell>
      <TableCell>
        <span className={`rounded-sm px-1.5 py-0.5 ${statusTone(user.status)}`}>
          {STATUS_NAME[user.status]}
        </span>
      </TableCell>
      <TableCell>
        {user.email_confirmed_at === null ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-warn">нет</span>
            {canChange && <ConfirmEmailButton userId={user.id} email={user.email} />}
          </span>
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
      <TableCell className="whitespace-normal">
        {canChange && self && (
          <span className="text-muted-foreground">
            ваша запись — состояние меняет другой администратор
          </span>
        )}
        {canChange && !self && user.status === 'disabled' && (
          <span className="text-muted-foreground">закрыта навсегда</span>
        )}
        {changeable && (
          <FormDialog
            label="Изменить"
            variant="outline"
            title={`Состояние учётной записи ${user.email}`}
            description={
              <>
                Сейчас — {STATUS_NAME[user.status].toLowerCase()}. Действие попадает в журнал вместе
                с тем, что было до.
              </>
            }
            open={open}
            onOpenChange={setOpen}
          >
            <StatusChoice
              user={user}
              onDone={() => {
                setOpen(false);
              }}
            />
          </FormDialog>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Содержимое окна «Изменить»: по кнопке на каждое состояние, кроме нынешнего.
 *
 * Мутации живут здесь, а не на странице: окно монтируется открытым, и отказ прошлого
 * открытия не встречает человека в следующем. Отказ открытия входа показывается в окне,
 * отказ подтверждаемого перевода — в окне подтверждения поверх него.
 */
function StatusChoice({ user, onDone }: { user: UserRow; onDone: () => void }) {
  const queryClient = useQueryClient();

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const activate = useMutation({
    mutationFn: () =>
      request<unknown>(`/users/${user.id}/status`, {
        method: 'PATCH',
        body: { status: 'active' },
      }),
    onSuccess: async () => {
      onDone();
      await invalidate();
    },
  });

  // Подтверждаемый перевод — своей мутацией: отказ виден в окне подтверждения.
  const confirmStatus = useMutation({
    mutationFn: (status: UserStatus) =>
      request<unknown>(`/users/${user.id}/status`, {
        method: 'PATCH',
        body: { status },
      }),
    onSuccess: async () => {
      onDone();
      await atMost(invalidate());
    },
  });

  const busy = activate.isPending || confirmStatus.isPending;
  const failed = asApiError(activate.error);
  // Участнику вход без подтверждённого адреса не открывается — API ответит отказом,
  // поэтому кнопка недоступна сразу и говорит почему (владелец, 2026-09-23).
  const unconfirmed = !isStaffRole(user.role) && user.email_confirmed_at === null;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-col gap-3 overflow-y-auto px-5 pb-4">
        <div className="flex flex-wrap gap-2">
          {USER_STATUSES.filter((status) => status !== user.status).map((status) =>
            status === 'active' ? (
              <Button
                key={status}
                type="button"
                variant="outline"
                size="sm"
                aria-disabled={busy}
                disabled={unconfirmed}
                className="aria-disabled:opacity-50"
                onClick={() => {
                  if (!busy) activate.mutate();
                }}
              >
                {activate.isPending ? 'Выполняем…' : USER_ACTION[status]}
              </Button>
            ) : (
              <ConfirmAction
                key={status}
                label={USER_ACTION[status]}
                title={`${USER_ACTION[status]}: ${user.email}`}
                consequence={<p>{STATUS_MEANING[status]}</p>}
                confirmLabel={USER_ACTION[status]}
                disabled={busy}
                onConfirm={() => confirmStatus.mutateAsync(status)}
              />
            ),
          )}
        </div>
        {unconfirmed && user.status !== 'active' && (
          <div className="flex flex-col gap-2 rounded-md bg-warn-soft px-3 py-2 text-warn">
            <span>
              Адрес не подтверждён — вход не открыть. Человек подтверждает его по ссылке из письма;
              если письмо не доходит, а адрес вы проверили иначе, подтвердите вручную.
            </span>
            <span className="self-start">
              <ConfirmEmailButton userId={user.id} email={user.email} />
            </span>
          </div>
        )}
        {failed !== undefined && <ErrorNote error={failed} />}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
        <DialogClose asChild>
          <Button type="button" variant="outline" size="sm">
            Отмена
          </Button>
        </DialogClose>
      </div>
    </div>
  );
}
