'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SMPP_ALLOWED_IPS_MAX, type SmppBindMode, type SmppReceiptMap } from '@zvonix/shared';
import { useState, type ReactNode } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import { OneTimeSecret } from '@/components/one-time-secret';
import { MODE_NAME, SmppEvents } from '@/components/smpp-events';
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
  /** Кто сейчас на связи под этим подключением (ADR-0096). */
  readonly online?: readonly { ip: string; mode: SmppBindMode; since: string }[];
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

const CARD = 'flex flex-col gap-3 rounded-lg border border-border bg-card p-4';

/**
 * Страница «SMPP» клиента по смыслу: «Вход» (сервер, имя, пароль, включено, адреса, кто на связи), «Ответы вашей программе»,
 * настройка отправки (`children` — «Если отправить сразу нельзя») и журнал подключений на всю ширину.
 */
export function SmppConnection({ children }: { readonly children?: ReactNode }) {
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<Issued | undefined>(undefined);
  const [ips, setIps] = useState<string | undefined>(undefined);

  const state = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => request<State>('/client/messages/smpp', { signal }),
    // «Сейчас на связи» должно быть свежим: программа подключается и отваливается сама.
    refetchInterval: 15_000,
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

  const secret = issued !== undefined && (
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
  );

  if (smpp === null) {
    return (
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <section className={CARD}>
          <h2 className="font-semibold">Вход по SMPP</h2>
          {secret}
          {listening ? (
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
          ) : (
            <p className="text-muted-foreground">SMPP пока не включён. Обратитесь в поддержку.</p>
          )}
          {error !== undefined && <ErrorNote error={error} />}
        </section>
        {children}
      </div>
    );
  }

  const allowed = typed
    .split(/[\s,;]+/u)
    .map((ip) => ip.trim())
    .filter((ip) => ip !== '');
  // Адрес, с которого программа сейчас на связи, но которого нет в непустом списке, — добавить одной кнопкой.
  const suggested =
    allowed.length === 0
      ? []
      : [...new Set((smpp.online ?? []).map((session) => session.ip))].filter(
          (ip) => !allowed.includes(ip),
        );

  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      {secret}

      {/* Всё про вход — в одной карточке: где, под каким именем, пароль, включено ли, откуда пускать и кто сейчас на связи
          (владелец, 2026-10-23: «новый пароль» стоял под ответами программе). */}
      <section className={CARD}>
        <h2 className="font-semibold">Вход по SMPP</h2>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5" translate="no">
          <dt className="text-muted-foreground">Сервер</dt>
          <dd className="num select-all">
            {connection.host}
            {connection.port !== null && `:${String(connection.port)}`}
          </dd>
          {connection.tls_port !== null && (
            <>
              <dt className="text-muted-foreground">С шифрованием</dt>
              <dd className="num select-all">
                {connection.host}:{String(connection.tls_port)}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Имя</dt>
          <dd className="num select-all">{smpp.system_id}</dd>
          <dt className="text-muted-foreground">Пароль</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">показывается один раз</span>
            <ConfirmAction
              label="Выпустить новый"
              title="Выпустить новый пароль SMPP"
              consequence="Прежний пароль перестанет подходить для новых подключений. Системе, которая сейчас подключена, придётся указать новый пароль."
              confirmLabel="Выпустить"
              tone="neutral"
              size="xs"
              onConfirm={async () => {
                const result = await request<Issued>('/client/messages/smpp/password', {
                  method: 'POST',
                });
                setIssued(result);
                await refresh();
              }}
            />
          </dd>
          <dt className="text-muted-foreground">Подключение</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {smpp.enabled ? (
              <>
                <span className="rounded-md bg-ok-soft px-2 py-0.5 text-ok">Включено</span>
                <ConfirmAction
                  label="Отключить"
                  title="Отключить подключение по SMPP"
                  consequence="Новые подключения будут отклоняться, пока вы не включите его снова."
                  confirmLabel="Отключить"
                  size="xs"
                  onConfirm={() => update.mutateAsync({ enabled: false })}
                />
              </>
            ) : (
              <>
                <span className="rounded-md bg-warn-soft px-2 py-0.5 text-warn">Отключено</span>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={update.isPending}
                  onClick={() => {
                    update.mutate({ enabled: true });
                  }}
                >
                  Включить
                </Button>
              </>
            )}
          </dd>
          <dt className="text-muted-foreground">Сейчас на связи</dt>
          <dd>
            {smpp.online === undefined || smpp.online.length === 0 ? (
              <span className="text-muted-foreground">нет</span>
            ) : (
              smpp.online.map((session) => (
                <span key={`${session.ip}-${session.since}`} className="block text-ok">
                  да, <span className="num">{session.ip}</span> с{' '}
                  <span className="num">{moment(session.since)}</span> · {MODE_NAME[session.mode]}
                </span>
              ))
            )}
          </dd>
          {/* Время входа, а не последней активности: программа входит раз и шлёт часами («был на связи» путало). */}
          <dt className="text-muted-foreground">Последний вход</dt>
          <dd className="num">{smpp.last_bind_at === null ? '—' : moment(smpp.last_bind_at)}</dd>
        </dl>

        <form
          className="flex flex-col gap-1 border-t border-border pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (update.isPending) return;
            update.mutate({ allowedIps: allowed });
          }}
        >
          <Label htmlFor="smpp-ips">Разрешённые адреса</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="smpp-ips"
              className="num max-w-md flex-1"
              autoComplete="off"
              placeholder={`любые; до ${String(SMPP_ALLOWED_IPS_MAX)} через запятую`}
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
          {suggested.map((ip) => (
            <div key={ip}>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  setIps([...allowed, ip].join(', '));
                }}
              >
                + {ip} — сейчас на связи
              </Button>
            </div>
          ))}
        </form>

        {error !== undefined && <ErrorNote error={error} />}
      </section>

      <div className="flex flex-col gap-4">
        <section className={CARD}>
          <SmppReceipts
            saved={smpp.receipts}
            saving={update.isPending}
            onSave={(receipts) => {
              update.mutate({ receipts });
            }}
          />
        </section>
        {children}
      </div>

      <section className={`${CARD} xl:col-span-2`}>
        <h2 className="font-semibold">Журнал подключений</h2>
        <SmppEvents url="/client/messages/smpp/events" />
      </section>
    </div>
  );
}
