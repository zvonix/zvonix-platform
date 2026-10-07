'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SMPP_ALLOWED_IPS_MAX, type SmppReceiptMap } from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { OneTimeSecret } from '@/components/one-time-secret';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, request } from '@/lib/api';
import { moment } from '@/lib/format';
import { SmppReceipts } from './smpp-receipts';

interface SmppAccount {
  readonly system_id: string;
  readonly enabled: boolean;
  readonly allowed_ips: readonly string[];
  readonly receipts: SmppReceiptMap;
  readonly last_bind_at: string | null;
}

interface Connection {
  readonly host: string;
  readonly port: number | null;
  readonly tls_port: number | null;
}

interface State {
  readonly enabled: boolean;
  readonly connection: Connection;
  readonly smpp: SmppAccount | null;
}

interface Issued {
  readonly smpp: SmppAccount;
  readonly password: string;
}

const KEY = ['client', 'messages', 'smpp'] as const;

/** Подключение клиента по SMPP: сервер, имя, пароль (виден один раз), список разрешённых адресов. */
export function SmppConnection() {
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<Issued | undefined>(undefined);
  const [ips, setIps] = useState<string | undefined>(undefined);

  const state = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => request<State>('/client/messages/smpp', { signal }),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });

  const create = useMutation({
    mutationFn: () => request<Issued>('/client/messages/smpp', { method: 'POST' }),
    onSuccess: async (result) => {
      setIssued(result);
      await refresh();
    },
  });

  const update = useMutation({
    mutationFn: (patch: { enabled?: boolean; allowedIps?: string[]; receipts?: SmppReceiptMap }) =>
      request<{ smpp: SmppAccount }>('/client/messages/smpp', { method: 'PATCH', body: patch }),
    onSuccess: async () => {
      setIps(undefined);
      await refresh();
    },
  });

  const data = state.data;
  if (data === undefined || !data.enabled) return null;

  const { connection, smpp } = data;
  const listening = connection.port !== null || connection.tls_port !== null;
  const error = [create.error, update.error, state.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  );
  const typed = ips ?? smpp?.allowed_ips.join(', ') ?? '';

  return (
    <section className="flex max-w-2xl flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-semibold">Подключение по SMPP</h2>

      {issued !== undefined && (
        <OneTimeSecret
          title="Пароль SMPP"
          onClose={() => {
            setIssued(undefined);
          }}
        >
          <p>Пароль показан один раз. Потеряете — выпустите новый.</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" translate="no">
            <dt className="text-muted-foreground">Имя</dt>
            <dd className="num select-all break-all">{issued.smpp.system_id}</dd>
            <dt className="text-muted-foreground">Пароль</dt>
            <dd className="num select-all break-all">{issued.password}</dd>
          </dl>
        </OneTimeSecret>
      )}

      {smpp === null && !listening && (
        <p className="text-muted-foreground">SMPP пока не включён. Обратитесь в поддержку.</p>
      )}

      {smpp === null && listening && (
        <div>
          <Button
            disabled={create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            {create.isPending ? 'Создаём…' : 'Создать подключение'}
          </Button>
        </div>
      )}

      {smpp !== null && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" translate="no">
            <dt className="text-muted-foreground">Сервер</dt>
            <dd className="num select-all">
              {connection.host}
              {connection.port !== null && `:${String(connection.port)}`}
            </dd>
            {connection.tls_port !== null && (
              <>
                <dt className="text-muted-foreground">Сервер с шифрованием</dt>
                <dd className="num select-all">
                  {connection.host}:{String(connection.tls_port)}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Имя</dt>
            <dd className="num select-all">{smpp.system_id}</dd>
            <dt className="text-muted-foreground">Был на связи</dt>
            <dd className="num">{smpp.last_bind_at === null ? '—' : moment(smpp.last_bind_at)}</dd>
          </dl>

          <form
            className="flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (update.isPending) return;
              update.mutate({
                allowedIps: typed
                  .split(/[\s,;]+/u)
                  .map((ip) => ip.trim())
                  .filter((ip) => ip !== ''),
              });
            }}
          >
            <Label htmlFor="smpp-ips">
              Разрешённые адреса (до {String(SMPP_ALLOWED_IPS_MAX)}, пусто — любые)
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="smpp-ips"
                className="num max-w-md"
                autoComplete="off"
                placeholder="203.0.113.5, 203.0.113.6"
                value={typed}
                onChange={(event) => {
                  setIps(event.target.value);
                }}
              />
              <Button
                type="submit"
                variant="outline"
                disabled={ips === undefined || update.isPending}
              >
                Сохранить
              </Button>
            </div>
          </form>

          <SmppReceipts
            saved={smpp.receipts}
            saving={update.isPending}
            onSave={(receipts) => {
              update.mutate({ receipts });
            }}
          />

          <div className="flex flex-wrap items-center gap-2">
            <ConfirmAction
              label="Новый пароль"
              title="Выпустить новый пароль SMPP"
              consequence="Прежний пароль перестанет подходить для новых подключений. Системе, которая сейчас подключена, придётся указать новый пароль."
              confirmLabel="Выпустить"
              tone="neutral"
              onConfirm={async () => {
                const result = await request<Issued>('/client/messages/smpp/password', {
                  method: 'POST',
                });
                setIssued(result);
                await refresh();
              }}
            />
            {smpp.enabled ? (
              <ConfirmAction
                label="Отключить"
                title="Отключить подключение по SMPP"
                consequence="Новые подключения будут отклоняться, пока вы не включите его снова."
                confirmLabel="Отключить"
                onConfirm={() => update.mutateAsync({ enabled: false })}
              />
            ) : (
              <>
                <span className="rounded-md bg-warn-soft px-2 py-0.5 text-warn">Отключено</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => {
                    update.mutate({ enabled: true });
                  }}
                >
                  Включить
                </Button>
              </>
            )}
          </div>
        </>
      )}

      {error !== undefined && <ErrorNote error={error} />}
    </section>
  );
}
