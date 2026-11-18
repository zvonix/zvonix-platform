'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LockOpen, ShieldBan } from 'lucide-react';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { FormDialog } from '@/components/form-dialog';
import { HEAD, ROW_ICON, RowActions, TABLE_FRAME } from '@/components/table-parts';
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

/**
 * Блокировки fail2ban узла — кто заблокирован, в какой тюрьме, до какого времени, и снять блок с одного адреса
 * ([ADR-0125](../../../../../docs/adr/0125-svoi-adresa-ne-blokiruyutsya.md)). 18.11.2026 тюрьма заблокировала
 * живого клиента на сутки, а снять блок можно было только по SSH. Список видят администратор и поддержка, снимает —
 * только администратор, и каждое снятие пишется в журнал.
 */

type BanJail = 'sip_foreign' | 'sip_known' | 'ssh';

interface NodeBans {
  readonly available: boolean;
  readonly message: string | null;
  readonly total: number;
  readonly bans: readonly { jail: BanJail; address: string; until: string | null }[];
}

/** Тюрьма словами: за что закрыт адрес. */
const JAIL_NAME: Record<BanJail, string> = {
  sip_foreign: 'SIP: подбор чужих логинов',
  sip_known: 'SIP: поток под логинами площадки',
  ssh: 'SSH: подбор пароля',
};

export function NodeBansButton({
  nodeId,
  nodeName,
  canChange,
}: {
  nodeId: string;
  nodeName: string;
  canChange: boolean;
}) {
  return (
    <FormDialog
      label={<ShieldBan aria-hidden className="size-4" />}
      tooltip="Блокировки"
      {...ROW_ICON}
      wide
      title={`Блокировки узла «${nodeName}»`}
      description="Адреса, которые fail2ban узла не пускает. Свои клиенты и партнёры в список не попадают"
    >
      <NodeBansList nodeId={nodeId} canChange={canChange} />
    </FormDialog>
  );
}

function NodeBansList({ nodeId, canChange }: { nodeId: string; canChange: boolean }) {
  const queryClient = useQueryClient();
  const key = ['nodes', nodeId, 'bans'];
  const list = useQuery({
    queryKey: key,
    queryFn: () => request<NodeBans>(`/nodes/${nodeId}/bans`),
    // Узел отвечает через службу команд, до полуминуты: не повторять сразу же.
    retry: false,
  });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const unban = useMutation({
    mutationFn: (address: string) =>
      request<{ removed: boolean; message: string }>(`/nodes/${nodeId}/bans/unban`, {
        method: 'POST',
        body: { address },
      }),
    onSuccess: async (reply, address) => {
      setNotice(reply.removed ? `${address}: блокировка снята` : `${address}: ${reply.message}`);
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const failed = list.error instanceof ApiError ? list.error : undefined;
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-5">
      {list.isPending && <p className="text-muted-foreground">Спрашиваем узел — до полуминуты…</p>}
      {failed !== undefined && <ErrorNote error={failed} />}
      {list.data !== undefined && !list.data.available && (
        <p className="text-warn">{list.data.message}</p>
      )}
      {notice !== undefined && <p role="status">{notice}</p>}
      {list.data?.available === true && (
        <>
          {list.data.total > list.data.bans.length && (
            <p className="text-muted-foreground">
              Показаны {list.data.bans.length} из {list.data.total}: ответ узла длиннее предела.
            </p>
          )}
          <div className={TABLE_FRAME}>
            <Table>
              <TableHeader>
                <TableRow className="text-muted-foreground hover:bg-transparent">
                  <TableHead className={HEAD}>Адрес</TableHead>
                  <TableHead className={HEAD}>За что</TableHead>
                  <TableHead className={HEAD}>До</TableHead>
                  <TableHead className={`${HEAD} w-px`}>
                    <span className="sr-only">Действия</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.bans.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4} className="text-muted-foreground">
                      Заблокированных адресов нет.
                    </TableCell>
                  </TableRow>
                )}
                {list.data.bans.map((ban) => (
                  <TableRow key={`${ban.jail}:${ban.address}`}>
                    <TableCell className="num select-all">{ban.address}</TableCell>
                    <TableCell>{JAIL_NAME[ban.jail]}</TableCell>
                    <TableCell className="num text-muted-foreground">
                      {ban.until === null ? 'срок не сообщён' : moment(ban.until)}
                    </TableCell>
                    <TableCell>
                      {canChange && (
                        <RowActions>
                          <ConfirmAction
                            label={<LockOpen aria-hidden className="size-4" />}
                            tooltip="Снять блокировку"
                            {...ROW_ICON}
                            title={`Снять блокировку ${ban.address}`}
                            consequence={
                              <p>
                                Адрес снова сможет входить по SIP и SSH на этот узел. Если это
                                сканер, fail2ban заблокирует его снова после новых неудачных
                                попыток. Действие попадёт в журнал.
                              </p>
                            }
                            confirmLabel="Снять блокировку"
                            tone="neutral"
                            disabled={unban.isPending}
                            onConfirm={() => unban.mutateAsync(ban.address)}
                          />
                        </RowActions>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
