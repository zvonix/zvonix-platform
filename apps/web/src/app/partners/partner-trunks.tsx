'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_TRUNK_CONCURRENT_CALLS,
  GATEWAY_STATUSES,
  REGISTRABLE_GATEWAY_STATUSES,
  type GatewayStatus,
} from '@zvonix/shared';
import { useState } from 'react';
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
import { useCanChange } from '@/lib/access';
import { ApiError, request } from '@/lib/api';
import { GATEWAY_STATUS_NAME, usableTone } from '@/lib/labels';

const COLUMNS = 6;

interface Trunk {
  readonly id: string;
  readonly node_id: string | null;
  readonly name: string;
  readonly status: GatewayStatus;
  readonly sip_username: string;
  readonly proxy_host: string;
  readonly registers_outbound: boolean;
  readonly outbound_username: string | null;
  readonly has_secret: boolean;
  readonly max_concurrent_calls: number;
}

interface Node {
  readonly id: string;
  readonly name: string;
}

/**
 * SIP-транки партнёра ([ADR-0039](../../../../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
 *
 * Второй род ёмкости рядом со шлюзами и SIM. Отличается тем, что **регистрация идёт
 * в обратную сторону**: не он к нам, а мы к нему. Отсюда и адрес провайдера, и пароль,
 * который платформа обязана уметь предъявить, — единственный такой в проекте.
 *
 * Пароль после сохранения не показывается никогда: в ответах API его нет, есть только
 * признак, что он задан. Заменить можно, посмотреть — нет.
 */
export function PartnerTrunks({ partnerId }: { partnerId: string }) {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | undefined>(undefined);

  const list = useQuery({
    queryKey: ['sip-trunks', partnerId],
    queryFn: () => request<{ trunks: Trunk[] }>(`/sip-trunks?partnerId=${partnerId}`),
  });

  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: async () => (await request<{ nodes: Node[] }>('/nodes')).nodes,
    staleTime: 60_000,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sip-trunks', partnerId] });
  };

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      request<unknown>('/sip-trunks', { method: 'POST', body: { partnerId, ...body } }),
    onSuccess: async () => {
      setCreating(false);
      await refresh();
    },
  });

  const update = useMutation({
    mutationFn: (input: { id: string; changes: Record<string, unknown> }) =>
      request<unknown>(`/sip-trunks/${input.id}`, { method: 'PATCH', body: input.changes }),
    onSuccess: async () => {
      setEditing(undefined);
      await refresh();
    },
  });

  const changeStatus = useMutation({
    mutationFn: (input: { id: string; status: GatewayStatus }) =>
      request<unknown>(`/gateways/${input.id}/status`, {
        method: 'POST',
        body: { status: input.status },
      }),
    onSuccess: refresh,
  });

  const failed = [list.error, create.error, update.error, changeStatus.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );
  const trunks = list.data?.trunks ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h3 className="font-semibold">SIP-транки</h3>
        {canChange && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => {
              setCreating(!creating);
            }}
            aria-expanded={creating}
          >
            {creating ? 'Свернуть' : 'Завести транк'}
          </Button>
        )}
      </div>

      <p className="text-muted-foreground">
        Ёмкость без SIM: вызовы уходят через транзитного оператора по интернету. Регистрация идёт от
        нас к провайдеру, поэтому нужны его адрес и учётные данные — либо доступ по адресу, если
        провайдер узнаёт нас по IP. Транк привязан к узлу: поднимает регистрацию именно он.
      </p>

      {failed !== undefined && (
        <p role="alert" className="text-crit">
          {failed.message}
        </p>
      )}

      {canChange && creating && (
        <NewTrunkForm
          nodes={nodes.data ?? []}
          busy={create.isPending}
          onCreate={(body) => {
            create.mutate(body);
          }}
        />
      )}

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Транк</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8">Провайдер</TableHead>
              <TableHead className="h-8">Доступ</TableHead>
              <TableHead className="h-8 text-right">Каналов</TableHead>
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

            {trunks.length === 0 && !list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="whitespace-normal text-muted-foreground">
                  Транков нет. Это не обязательный род ёмкости: партнёр может работать только SIM.
                </TableCell>
              </TableRow>
            )}

            {trunks.map((trunk) => (
              <TableRow key={trunk.id}>
                <TableCell>
                  {trunk.name}
                  <span className="num block text-faint">{trunk.sip_username}</span>
                </TableCell>

                <TableCell>
                  {canChange ? (
                    <select
                      value={trunk.status}
                      disabled={changeStatus.isPending}
                      onChange={(event) => {
                        changeStatus.mutate({
                          id: trunk.id,
                          status: event.target.value as GatewayStatus,
                        });
                      }}
                      className={`h-7 rounded-md border border-input px-1 ${usableTone(
                        REGISTRABLE_GATEWAY_STATUSES.includes(trunk.status),
                      )}`}
                    >
                      {GATEWAY_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {GATEWAY_STATUS_NAME[status]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span
                      className={`rounded-sm px-1.5 py-0.5 ${usableTone(
                        REGISTRABLE_GATEWAY_STATUSES.includes(trunk.status),
                      )}`}
                    >
                      {GATEWAY_STATUS_NAME[trunk.status]}
                    </span>
                  )}
                </TableCell>

                <TableCell className="num">{trunk.proxy_host}</TableCell>

                <TableCell className="whitespace-normal">
                  {trunk.registers_outbound ? (
                    <>
                      регистрация
                      <span className="num block text-faint">
                        {trunk.outbound_username ?? '—'}
                        {trunk.has_secret ? ' · пароль задан' : ' · пароля нет'}
                      </span>
                    </>
                  ) : (
                    <>
                      по адресу
                      <span className="block text-faint">провайдер узнаёт нас по IP</span>
                    </>
                  )}
                </TableCell>

                <TableCell className="num text-right">{trunk.max_concurrent_calls}</TableCell>

                <TableCell>
                  {canChange &&
                    (editing === trunk.id ? (
                      <EditTrunk
                        trunk={trunk}
                        busy={update.isPending}
                        onSave={(changes) => {
                          update.mutate({ id: trunk.id, changes });
                        }}
                        onCancel={() => {
                          setEditing(undefined);
                        }}
                      />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditing(trunk.id);
                        }}
                      >
                        Настроить
                      </Button>
                    ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Заведение транка: адрес провайдера, способ доступа и ёмкость. */
function NewTrunkForm({
  nodes,
  busy,
  onCreate,
}: {
  nodes: readonly Node[];
  busy: boolean;
  onCreate: (body: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [proxyHost, setProxyHost] = useState('');
  const [registers, setRegisters] = useState(true);
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [channels, setChannels] = useState(String(DEFAULT_TRUNK_CONCURRENT_CALLS));

  const ready =
    name.trim().length >= 2 &&
    nodeId !== '' &&
    proxyHost.trim() !== '' &&
    (!registers || (username.trim() !== '' && secret !== ''));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onCreate({
          nodeId,
          name: name.trim(),
          proxyHost: proxyHost.trim(),
          registersOutbound: registers,
          ...(registers ? { outboundUsername: username.trim(), outboundSecret: secret } : {}),
          maxConcurrentCalls: channels,
        });
      }}
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Название</span>
          <Input
            className="w-[180px]"
            placeholder="Транзит основной"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Узел</span>
          <select
            value={nodeId}
            onChange={(event) => {
              setNodeId(event.target.value);
            }}
            className="h-9 w-[180px] rounded-md border border-input bg-transparent px-2"
          >
            <option value="">выберите</option>
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Адрес провайдера</span>
          <Input
            className="num w-[220px]"
            placeholder="sip.provider.ru:5060"
            value={proxyHost}
            onChange={(event) => {
              setProxyHost(event.target.value);
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Каналов</span>
          <Input
            className="num w-[90px]"
            value={channels}
            onChange={(event) => {
              setChannels(event.target.value);
            }}
          />
        </label>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={registers}
          onChange={(event) => {
            setRegisters(event.target.checked);
          }}
        />
        <span>Регистрироваться у провайдера</span>
      </label>

      {registers && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Имя у провайдера</span>
            <Input
              className="num w-[180px]"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Пароль провайдера</span>
            <Input
              className="num w-[220px]"
              type="password"
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value);
              }}
            />
          </label>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!ready || busy}>
          Завести
        </Button>
        <span className="text-muted-foreground">
          Транк заводится выключенным: включите его, когда провайдер подтвердит доступ. Пароль после
          сохранения не показывается — его можно заменить, но не посмотреть.
        </span>
      </div>
    </form>
  );
}

/**
 * Правка транка.
 *
 * Пустое поле пароля означает «не трогать», а не «очистить»: правка адреса не должна
 * стирать учётные данные — транк перестал бы подниматься, и увидеть это можно было бы
 * только в логе узла.
 */
function EditTrunk({
  trunk,
  busy,
  onSave,
  onCancel,
}: {
  trunk: Trunk;
  busy: boolean;
  onSave: (changes: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [proxyHost, setProxyHost] = useState(trunk.proxy_host);
  const [channels, setChannels] = useState(String(trunk.max_concurrent_calls));
  const [secret, setSecret] = useState('');

  const changes: Record<string, unknown> = {};
  if (proxyHost.trim() !== trunk.proxy_host) changes.proxyHost = proxyHost.trim();
  if (channels !== String(trunk.max_concurrent_calls)) changes.maxConcurrentCalls = channels;
  if (secret !== '') changes.outboundSecret = secret;
  const dirty = Object.keys(changes).length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) onSave(changes);
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <Input
        className="num w-[180px]"
        value={proxyHost}
        onChange={(event) => {
          setProxyHost(event.target.value);
        }}
      />
      <Input
        className="num w-[70px]"
        value={channels}
        onChange={(event) => {
          setChannels(event.target.value);
        }}
      />
      <Input
        className="num w-[160px]"
        type="password"
        placeholder="новый пароль"
        value={secret}
        onChange={(event) => {
          setSecret(event.target.value);
        }}
      />
      <Button type="submit" size="sm" disabled={!dirty || busy}>
        Сохранить
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>
        Отмена
      </Button>
    </form>
  );
}
