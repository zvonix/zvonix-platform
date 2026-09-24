'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NODE_OFFLINE_AFTER_MS, type NodeStatus } from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { DialogForm, FormDialog } from '@/components/form-dialog';
import { OneTimeSecret } from '@/components/one-time-secret';
import { ReadOnly } from '@/components/read-only';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, request } from '@/lib/api';
import { atMost } from '@/lib/wait';
import { useCanChange } from '@/lib/access';
import { moment } from '@/lib/format';
import { NODE_STATUS_MEANING, NODE_STATUS_NAME, nodeTone } from '@/lib/labels';
import { AllowedIpsField, parseAddresses } from './allowed-ips';
import { NewNodeForm, type NodeDraft } from './new-node-form';

const COLUMNS = 7;

interface Node {
  readonly id: string;
  readonly name: string;
  readonly hostname: string | null;
  readonly sip_address: string | null;
  readonly status: NodeStatus;
  readonly agent_version: string | null;
  readonly active_calls: number;
  readonly last_heartbeat_at: string | null;
  readonly created_at: string;
}

interface Provisioned {
  readonly node: Node;
  readonly install: { command: string; token_expires_at: string | null };
}

/** Показанная один раз команда установки вместе с тем, к какому узлу она относится. */
interface Install {
  readonly nodeName: string;
  readonly command: string;
  readonly expiresAt: string | null;
}

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

export default function NodesPage() {
  return (
    <ConsoleShell title="Узлы АТС" requireRole={['admin', 'support']}>
      {() => <NodesView />}
    </ConsoleShell>
  );
}

function NodesView() {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [install, setInstall] = useState<Install | undefined>(undefined);

  const list = useQuery({
    queryKey: ['nodes'],
    queryFn: () => request<{ nodes: Node[] }>('/nodes'),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['nodes'] });
  };

  /** Команда установки приходит и при заведении, и при перевыпуске — показ один и тот же. */
  const remember = (provisioned: Provisioned) => {
    setInstall({
      nodeName: provisioned.node.name,
      command: provisioned.install.command,
      expiresAt: provisioned.install.token_expires_at,
    });
  };

  const provision = useMutation({
    mutationFn: (draft: NodeDraft) =>
      request<Provisioned>('/nodes', { method: 'POST', body: { ...draft } }),
    onSuccess: async (provisioned) => {
      remember(provisioned);
      await refresh();
    },
  });

  const reissue = useMutation({
    mutationFn: (input: { id: string; allowedIps: string[] }) =>
      request<Provisioned>(`/nodes/${input.id}/install-command`, {
        method: 'POST',
        body: { allowedIps: input.allowedIps },
      }),
    onSuccess: async (provisioned) => {
      remember(provisioned);
      await refresh();
    },
  });

  // Вывод из эксплуатации идёт через подтверждение, и его отказ показывается там же:
  // в общей строке ошибок он повторился бы вторым сообщением.
  const decommission = useMutation({
    mutationFn: (id: string) =>
      request<{ node: Node }>(`/nodes/${id}/decommission`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      await atMost(refresh());
    },
  });

  const busy = provision.isPending || reissue.isPending || decommission.isPending;
  // Отказы заведения и перевыпуска показывает их окно, здесь — только отказ списка.
  const failed = asApiError(list.error);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground">
          Узел — машина с FreeSWITCH, через которую идут вызовы. Без узла в состоянии «работает» не
          звонит ни один канал: маршрут запрашивает узел, и спросить его некому.
        </p>
        {canChange ? (
          <FormDialog
            label="Добавить узел"
            title="Новый узел"
            description="После добавления кабинет один раз покажет команду установки для сервера."
            className="ml-auto"
          >
            <NewNodeForm onCreate={(draft) => provision.mutateAsync(draft)} />
          </FormDialog>
        ) : (
          // Обёртка — блок, а не `span`: внутри `ReadOnly` абзац, и строчный элемент
          // вокруг абзаца — недопустимая разметка.
          <div className="ml-auto">
            <ReadOnly what="узлы" />
          </div>
        )}
      </div>

      {failed !== undefined && <ErrorNote error={failed} />}

      {install !== undefined && (
        <OneTimeSecret
          title={`Команда установки для «${install.nodeName}»`}
          onClose={() => {
            setInstall(undefined);
          }}
        >
          <p>
            Команда содержит <b>одноразовый токен</b> в открытом виде — иначе её нельзя выполнить.
            Второго показа не будет: повторно выдаётся новая команда, а прежний токен перестаёт
            работать.
            {install.expiresAt !== null && (
              <>
                {' '}
                Токен действует до <span className="num">{moment(install.expiresAt)}</span> — после
                этого понадобится перевыпуск.
              </>
            )}
          </p>
          <pre
            className="num overflow-x-auto rounded-md border border-border bg-card p-2 select-all"
            translate="no"
          >
            {install.command}
          </pre>
          <p className="text-muted-foreground">
            Выполнять на будущем узле от имени пользователя с правами администратора. Пока команда
            не выполнена, узел остаётся в состоянии «добавлен» и вызовов не принимает.
          </p>
        </OneTimeSecret>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Узел</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8">Адрес SIP</TableHead>
              <TableHead className="h-8 text-right">Вызовов</TableHead>
              <TableHead className="h-8">Последний отклик</TableHead>
              <TableHead className="h-8">Агент</TableHead>
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

            {list.data?.nodes.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="whitespace-normal text-muted-foreground">
                  Узлов нет — значит, вызовы не идут вовсе: маршрут запрашивает узел.
                  {canChange && ' Добавьте первый и выполните выданную команду на сервере.'}
                </TableCell>
              </TableRow>
            )}

            {list.data?.nodes.map((node) => (
              <NodeRows
                key={node.id}
                node={node}
                busy={busy}
                canChange={canChange}
                onReissue={(allowedIps) => reissue.mutateAsync({ id: node.id, allowedIps })}
                onDecommission={() => decommission.mutateAsync(node.id)}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function NodeRows({
  node,
  busy,
  canChange,
  onReissue,
  onDecommission,
}: {
  node: Node;
  busy: boolean;
  canChange: boolean;
  onReissue: (allowedIps: string[]) => Promise<unknown>;
  onDecommission: () => Promise<unknown>;
}) {
  const closed = node.status === 'decommissioned';

  return (
    <TableRow>
      <TableCell>
        {node.name}
        <span className="num block text-faint" translate="no">
          {node.hostname ?? 'машина не отвечала'}
        </span>
      </TableCell>

      <TableCell>
        <span
          className={`rounded-md px-2 py-0.5 ${nodeTone(node.status)}`}
          title={NODE_STATUS_MEANING[node.status]}
        >
          {NODE_STATUS_NAME[node.status]}
        </span>
      </TableCell>

      <TableCell>
        {node.sip_address === null ? (
          <span className="text-faint">не задан</span>
        ) : (
          <span className="num" translate="no">
            {node.sip_address}
          </span>
        )}
      </TableCell>

      <TableCell className="num text-right">{node.active_calls}</TableCell>

      <TableCell>
        <Heartbeat at={node.last_heartbeat_at} closed={closed} />
      </TableCell>

      <TableCell>
        {node.agent_version === null ? (
          <span className="text-faint">—</span>
        ) : (
          <span className="num">{node.agent_version}</span>
        )}
      </TableCell>

      <TableCell>
        {/*
          Два действия разной тяжести: перевыпуск команды обратим и идёт окном с полем,
          вывод из эксплуатации необратим и идёт через подтверждение с последствием
          (DESIGN.md, «Опасные действия»).
        */}
        {canChange && !closed && (
          <div className="flex justify-end gap-2">
            <FormDialog
              label="Новая команда"
              title={`Новая команда установки для «${node.name}»`}
              description={`Состояние сейчас: ${NODE_STATUS_MEANING[node.status]}`}
              variant="outline"
              disabled={busy}
            >
              <ReissueInstall onReissue={onReissue} />
            </FormDialog>

            <ConfirmAction
              label="Вывести"
              title={`Вывести узел «${node.name}» из эксплуатации`}
              consequence={
                <>
                  <p>Все ключи узла отзываются, вызовы через него прекращаются.</p>
                  <p>
                    Запись остаётся: на неё ссылаются CDR. Состояние окончательное — вернуть узел в
                    работу нельзя, понадобится завести новый.
                  </p>
                </>
              }
              confirmLabel="Вывести навсегда"
              disabled={busy}
              onConfirm={onDecommission}
            />
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Перевыпуск команды установки.
 *
 * Адреса спрашиваются **заново**, а не берутся от прежнего токена: ограничение
 * принадлежит токену, а не узлу, и старый токен здесь как раз и перестаёт работать.
 * Форма без этого поля молча снимала бы защиту, поставленную при заведении.
 */
function ReissueInstall({ onReissue }: { onReissue: (allowedIps: string[]) => Promise<unknown> }) {
  const [allowedIps, setAllowedIps] = useState('');

  return (
    <DialogForm submitLabel="Выдать команду" onSubmit={() => onReissue(parseAddresses(allowedIps))}>
      <p className="text-muted-foreground sm:col-span-2">
        Прежний токен перестаёт работать. Нужно, когда установка отложилась больше чем на час.
      </p>
      <AllowedIpsField
        value={allowedIps}
        onChange={setAllowedIps}
        hint="Адреса задаются заново: ограничение принадлежит токену, а не узлу, и прежнее уходит вместе со старым токеном. Пусто — установка примется с любого адреса."
      />
    </DialogForm>
  );
}

/**
 * Когда узел откликался в последний раз.
 *
 * Молчание дольше полутора минут — не «давно», а «снят с маршрутизации»: порог берётся
 * из общей константы, а не пишется здесь числом, иначе экран и маршрутизация однажды
 * разойдутся в том, что считать живым.
 */
function Heartbeat({ at, closed }: { at: string | null; closed: boolean }) {
  if (at === null) return <span className="text-faint">не откликался</span>;

  const silent = Date.now() - Date.parse(at) > NODE_OFFLINE_AFTER_MS;
  return (
    <span className={silent && !closed ? 'num text-crit' : 'num text-muted-foreground'}>
      {moment(at)}
    </span>
  );
}
