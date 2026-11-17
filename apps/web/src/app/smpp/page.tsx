'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { FormDialog } from '@/components/form-dialog';
import { SmppEvents } from '@/components/smpp-events';
import { StatusDot } from '@/components/status-dot';
import { HEAD, ROW_ICON, RowActions, TABLE_FRAME, WIDE_ONLY } from '@/components/table-parts';
import { Button } from '@/components/ui/button';
import { WithTooltip } from '@/components/ui/tooltip';
import { Power, ScrollText } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';

/**
 * SMPP у сотрудников ([ADR-0096](../../../../../docs/adr/0096-zhurnal-podklyucheniy-smpp.md), дополнение 2026-10-23): подключения
 * клиентов, адреса на паузе за подбор пароля и журнал площадки — с входами под неизвестным именем. Раньше таблица подключений
 * стояла внизу «Аккаунтов и бота» и пропадала, пока подключений нет, а неизвестные имена не писались нигде (владелец: «где
 * посмотреть, кто долбится, заблокирован ли IP?»).
 */
export default function SmppPage() {
  return (
    <ConsoleShell title="SMPP" requireRole={['admin', 'support']}>
      {() => (
        <div className="flex max-w-6xl flex-col gap-6">
          <SmppConnections />
          <BlockedAddresses />
          <section aria-label="Журнал площадки" className="flex flex-col gap-2">
            <h2 className="font-semibold">Журнал площадки</h2>
            <SmppEvents url="/smpp/events" platform />
          </section>
        </div>
      )}
    </ConsoleShell>
  );
}

/** Адреса на паузе прямо сейчас: пять неверных входов за минуту — минута без входа. */
function BlockedAddresses() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const blocked = useQuery({
    queryKey: ['smpp', 'blocked'],
    queryFn: ({ signal }) =>
      request<{ blocked: { ip: string; failures: number; until: string }[] }>('/smpp/blocked', {
        signal,
      }),
    refetchInterval: 5_000,
  });
  const release = useMutation({
    mutationFn: (ip: string) =>
      request<unknown>(`/smpp/blocked/${encodeURIComponent(ip)}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['smpp'] }),
  });
  const error = [blocked.error, release.error].find((e) => e instanceof ApiError);
  const rows = blocked.data?.blocked ?? [];

  return (
    <section aria-label="Адреса на паузе" className="flex flex-col gap-2">
      <h2 className="font-semibold">Адреса на паузе</h2>
      {error !== undefined && <ErrorNote error={error} />}
      {blocked.data !== undefined && rows.length === 0 ? (
        <p className="text-muted-foreground">Сейчас никто не на паузе.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.ip} className="flex flex-wrap items-center gap-3">
              <span className="num">{row.ip}</span>
              <span className="text-warn">
                {String(row.failures)} неверных входов · пауза до {moment(row.until)}
              </span>
              {canChange && (
                <button
                  type="button"
                  disabled={release.isPending}
                  onClick={() => {
                    release.mutate(row.ip);
                  }}
                  className="min-h-7 rounded-md border border-border px-2 hover:bg-muted"
                >
                  Снять
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface SmppConnection {
  readonly client_id: string;
  readonly client_name: string | null;
  readonly system_id: string;
  readonly enabled: boolean;
  readonly allowed_ips: readonly string[];
  readonly last_bind_at: string | null;
  /** Сейчас на связи (ADR-0096). */
  readonly online: readonly { ip: string }[];
}

/**
 * Подключения клиентов по SMPP ([ADR-0072](../../../../../docs/adr/0072-smpp-dlya-soobscheniy.md)): кто подключён и
 * когда заходил в последний раз. Администратор может отключить подключение (например, при подозрении на утечку
 * пароля) и вернуть его; пароль и адреса клиента он не видит и не меняет. Пока подключений нет, блока нет.
 */
function SmppConnections() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['smpp', 'accounts'],
    queryFn: ({ signal }) => request<{ accounts: SmppConnection[] }>('/smpp/accounts', { signal }),
    refetchInterval: 30_000,
  });
  const toggle = useMutation({
    mutationFn: (input: { clientId: string; enabled: boolean }) =>
      request<unknown>(`/smpp/accounts/${input.clientId}`, {
        method: 'PATCH',
        body: { enabled: input.enabled },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['smpp', 'accounts'] }),
  });

  const accounts = list.data?.accounts ?? [];
  if (list.data !== undefined && accounts.length === 0) {
    return <p className="text-muted-foreground">Подключений по SMPP у клиентов пока нет.</p>;
  }

  return (
    <section aria-label="Подключения по SMPP" className="flex flex-col gap-2">
      <h2 className="font-semibold">Подключения клиентов</h2>
      <div className={TABLE_FRAME}>
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className={HEAD}>Клиент</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Имя входа</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Адреса</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Был на связи</TableHead>
              <TableHead className={HEAD}>Состояние</TableHead>
              <TableHead className={`${HEAD} w-px`}>
                <span className="sr-only">Действия</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => (
              <TableRow key={account.client_id}>
                <TableCell>{account.client_name ?? account.client_id}</TableCell>
                <TableCell className={WIDE_ONLY}>
                  <span className="num">{account.system_id}</span>
                </TableCell>
                <TableCell className={`text-muted-foreground ${WIDE_ONLY}`}>
                  {account.allowed_ips.length === 0
                    ? 'любые'
                    : `ограничены: ${String(account.allowed_ips.length)}`}
                </TableCell>
                <TableCell className={WIDE_ONLY}>
                  {account.online.length > 0 ? (
                    <StatusDot
                      tone="ok"
                      label="сейчас на связи"
                      reason={account.online.map((s) => s.ip).join(', ')}
                    />
                  ) : (
                    <span className="num text-muted-foreground">
                      {moment(account.last_bind_at)}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {/* Слово остаётся и у «Включено»: рубильника в строке нет, состояние читается только здесь. */}
                  <StatusDot
                    tone={account.enabled ? 'ok' : 'warn'}
                    label={account.enabled ? 'Включено' : 'Отключено'}
                  />
                </TableCell>
                <TableCell>
                  <RowActions>
                    {/* Журнал подключения — и поддержке: «подключается ли программа клиента» (ADR-0096). */}
                    <FormDialog
                      label={<ScrollText aria-hidden className="size-4" />}
                      tooltip="Журнал"
                      {...ROW_ICON}
                      title={`Журнал SMPP: ${account.client_name ?? account.system_id}`}
                    >
                      <SmppEvents url={`/smpp/accounts/${account.client_id}/events`} />
                    </FormDialog>
                    {canChange &&
                      (account.enabled ? (
                        <ConfirmAction
                          label={<Power aria-hidden className="size-4" />}
                          tooltip="Отключить"
                          {...ROW_ICON}
                          title={`Отключить SMPP клиента «${account.client_name ?? account.system_id}»`}
                          consequence="Новые подключения клиента будут отклоняться, пока вы не включите его снова. Открытые сессии доживут до разрыва."
                          confirmLabel="Отключить"
                          onConfirm={() =>
                            toggle.mutateAsync({ clientId: account.client_id, enabled: false })
                          }
                        />
                      ) : (
                        <WithTooltip label="Включить">
                          <Button
                            {...ROW_ICON}
                            aria-label="Включить"
                            disabled={toggle.isPending}
                            onClick={() => {
                              toggle.mutate({ clientId: account.client_id, enabled: true });
                            }}
                          >
                            <Power aria-hidden className="size-4" />
                          </Button>
                        </WithTooltip>
                      ))}
                  </RowActions>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
