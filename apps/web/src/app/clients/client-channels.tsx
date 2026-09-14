'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CHANNEL_STATUSES, type ChannelStatus } from '@zvonix/shared';
import { Fragment, useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ErrorNote } from '@/components/error-note';
import type { IssuedCredentials, SipAccount } from '@/components/sip-credentials';
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
import { atMost } from '@/lib/wait';
import { CHANNEL_STATUS_MEANING, CHANNEL_STATUS_NAME, usableTone } from '@/lib/labels';

interface Channel {
  readonly id: string;
  readonly name: string;
  readonly status: ChannelStatus;
  readonly sip_username: string;
  readonly recording_required: boolean;
  readonly caller_id: string | null;
}

const COLUMNS = 6;

/**
 * Кнопка называет действие, а не состояние: «Приостановлен» рядом с плашкой текущего
 * состояния читалось как ещё одна плашка.
 */
const CHANNEL_ACTION: Record<ChannelStatus, string> = {
  pending: 'Вернуть в «ждёт»',
  active: 'Разрешить звонить',
  suspended: 'Приостановить',
};

const asApiError = (error: unknown): ApiError | undefined =>
  error instanceof ApiError ? error : undefined;

/**
 * Каналы клиента — линии, по которым он звонит.
 *
 * **Канал — не порт.** Канал это линия клиента, порт — слот с SIM у партнёра
 * ([GLOSSARY.md](../../../../../docs/GLOSSARY.md)).
 *
 * Канал заводится `pending`: учётная запись SIP выдана, но звонить по ней нельзя,
 * пока администратор не переведёт канал в «работает». Маршрутизация требует `active`
 * **и от канала, и от самого клиента** — закрытый клиент не звонит ни по одному каналу.
 *
 * Разрешение звонить — одним нажатием. Остановка линии и перевыпуск доступа — через
 * подтверждение с последствием: раньше оба срабатывали с первого нажатия, а перевыпуск
 * молча обрывал регистрацию АТС клиента (ui-review, 2026-09-14).
 *
 * Выданный пароль уходит наверх (`onIssued`) и показывается над таблицей клиентов: этот
 * блок живёт внутри строки клиента, и при её сворачивании панель пропадала вместе с ним.
 */
export function ClientChannels({
  clientId,
  onIssued,
}: {
  clientId: string;
  onIssued: (issued: IssuedCredentials) => void;
}) {
  const canChange = useCanChange();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [callerId, setCallerId] = useState('');
  const [recordingRequired, setRecordingRequired] = useState(false);

  const list = useQuery({
    queryKey: ['channels', clientId],
    queryFn: () => request<{ channels: Channel[] }>(`/channels?clientId=${clientId}`),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['channels', clientId] });
  };

  const create = useMutation({
    mutationFn: () =>
      request<{ account: SipAccount }>('/channels', {
        method: 'POST',
        body: {
          clientId,
          name,
          recordingRequired,
          ...(callerId.trim() === '' ? {} : { callerId: callerId.trim() }),
        },
      }),
    onSuccess: async (data) => {
      setCreating(false);
      setName('');
      setCallerId('');
      onIssued({ title: `Доступ SIP для канала «${name}»`, account: data.account });
      await invalidate();
    },
  });

  const activate = useMutation({
    mutationFn: (id: string) =>
      request<unknown>(`/channels/${id}/status`, {
        method: 'POST',
        body: { status: 'active' },
      }),
    onSuccess: invalidate,
  });

  // Подтверждаемые действия — своими мутациями: их отказ показывается в окне
  // подтверждения и не повторяется в общей строке ошибок.
  const confirmStatus = useMutation({
    mutationFn: (input: { id: string; status: ChannelStatus }) =>
      request<unknown>(`/channels/${input.id}/status`, {
        method: 'POST',
        body: { status: input.status },
      }),
    onSuccess: () => atMost(invalidate()),
  });

  const reissue = useMutation({
    mutationFn: (channel: Channel) =>
      request<{ account: SipAccount }>(`/channels/${channel.id}/credentials`, { method: 'POST' }),
    onSuccess: (data, channel) => {
      onIssued({ title: `Новый доступ SIP для канала «${channel.name}»`, account: data.account });
      void invalidate();
    },
  });

  const edit = useMutation({
    mutationFn: (input: { id: string; changes: Record<string, unknown> }) =>
      request<unknown>(`/channels/${input.id}`, { method: 'PATCH', body: input.changes }),
    onSuccess: async () => {
      setEditing(undefined);
      await invalidate();
    },
  });

  const failed = asApiError(create.error ?? activate.error ?? edit.error ?? list.error);
  const channels = list.data?.channels ?? [];
  const nameValid = name.trim().length >= 2;
  const busy = activate.isPending || confirmStatus.isPending || reissue.isPending;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h3 className="font-semibold">Каналы</h3>
        {canChange && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCreating(!creating);
            }}
          >
            {creating ? 'Отменить' : 'Завести канал'}
          </Button>
        )}
      </div>

      {list.data !== undefined && channels.length === 0 && (
        <p className="text-warn">
          Каналов нет — клиенту нечем подключиться к платформе и не с чего звонить.
        </p>
      )}

      {canChange && creating && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (nameValid) create.mutate();
          }}
          className="flex max-w-[900px] flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Название</span>
            <Input
              className="w-[220px]"
              value={name}
              autoComplete="off"
              placeholder="Диспетчерская"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Номер для показа</span>
            <Input
              className="num w-[180px]"
              inputMode="tel"
              autoComplete="off"
              spellCheck={false}
              value={callerId}
              placeholder="номер SIM"
              onChange={(event) => {
                setCallerId(event.target.value);
              }}
            />
          </label>

          <label className="flex items-center gap-2 pb-2">
            <input
              type="checkbox"
              checked={recordingRequired}
              onChange={(event) => {
                setRecordingRequired(event.target.checked);
              }}
            />
            <span>Запись разговора обязательна</span>
          </label>

          <Button type="submit" size="sm" disabled={!nameValid || create.isPending}>
            {create.isPending ? 'Заводим…' : 'Завести'}
          </Button>

          {name !== '' && !nameValid && (
            <p className="w-full text-warn">Название — не короче двух знаков.</p>
          )}

          <p className="w-full text-muted-foreground">
            {/*
              ADR-0012: на шлюзе типа `android` запись технически невозможна, и такой
              канал туда не маршрутизируется вовсе. Сказать это при заведении дешевле,
              чем разбирать потом «почему через этого партнёра не звонит».
            */}
            Канал заведётся в состоянии «ждёт»: доступ SIP выдан, но звонки не пойдут, пока вы не
            переведёте его в «работает». Канал с обязательной записью не уйдёт на шлюзы вида
            «Android» — там запись невозможна, и выбор партнёров у такого канала уже. Пустой номер
            для показа означает «номер той SIM, с которой ушёл вызов».
          </p>
        </form>
      )}

      {failed !== undefined && <ErrorNote error={failed} />}

      <div className="max-w-[900px] overflow-x-auto rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Канал</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8">Имя SIP</TableHead>
              <TableHead className="h-8">Запись</TableHead>
              <TableHead className="h-8">Номер для показа</TableHead>
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

            {channels.map((channel) => (
              <Fragment key={channel.id}>
                <TableRow>
                  <TableCell>{channel.name}</TableCell>
                  <TableCell>
                    <span
                      className={`rounded-sm px-1.5 py-0.5 ${usableTone(channel.status === 'active')}`}
                    >
                      {CHANNEL_STATUS_NAME[channel.status]}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="num" translate="no">
                      {channel.sip_username}
                    </span>
                  </TableCell>
                  <TableCell>
                    {channel.recording_required ? (
                      'обязательна'
                    ) : (
                      <span className="text-muted-foreground">не нужна</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {channel.caller_id === null ? (
                      <span className="text-muted-foreground">номер SIM</span>
                    ) : (
                      <span className="num">{channel.caller_id}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {/*
                      Поддержке действий не показывают вовсе: изменяющие обработчики
                      каналов помечены `@Roles('admin')`, и каждая из этих кнопок
                      ответила бы ей отказом (DESIGN.md).
                    */}
                    {canChange && (
                      <div className="flex flex-wrap gap-1">
                        {CHANNEL_STATUSES.filter((status) => status !== channel.status).map(
                          (status) =>
                            status === 'active' ? (
                              <Button
                                key={status}
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  activate.mutate(channel.id);
                                }}
                              >
                                {CHANNEL_ACTION[status]}
                              </Button>
                            ) : (
                              <ConfirmAction
                                key={status}
                                label={CHANNEL_ACTION[status]}
                                title={`${CHANNEL_ACTION[status]}: канал «${channel.name}»`}
                                consequence={<p>{CHANNEL_STATUS_MEANING[status]}</p>}
                                confirmLabel={CHANNEL_ACTION[status]}
                                disabled={busy}
                                onConfirm={() =>
                                  confirmStatus.mutateAsync({ id: channel.id, status })
                                }
                              />
                            ),
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditing(editing === channel.id ? undefined : channel.id);
                          }}
                          aria-expanded={editing === channel.id}
                        >
                          {editing === channel.id ? 'Свернуть' : 'Настроить'}
                        </Button>
                        {/*
                          Пароль SIP восстановить неоткуда, а утёкший пароль канала — это
                          чужие вызовы за счёт клиента. Без перевыпуска единственным ответом
                          на утечку было бы отключение канала целиком.
                        */}
                        <ConfirmAction
                          label="Перевыпустить доступ"
                          title={`Перевыпустить доступ канала «${channel.name}»`}
                          consequence={
                            <>
                              <p>
                                Имя и пароль SIP меняются сразу. АТС клиента потеряет регистрацию и
                                не сможет звонить по этой линии, пока в неё не введут новые данные.
                              </p>
                              <p>
                                Нужно, когда прежний пароль мог утечь: утёкший пароль линии — это
                                чужие вызовы за счёт клиента.
                              </p>
                            </>
                          }
                          confirmLabel="Перевыпустить"
                          disabled={busy}
                          onConfirm={() => reissue.mutateAsync(channel)}
                        />
                      </div>
                    )}
                  </TableCell>
                </TableRow>

                {editing === channel.id && (
                  <TableRow key={`${channel.id}-edit`} className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={COLUMNS} className="whitespace-normal">
                      <ChannelSettings
                        channel={channel}
                        busy={edit.isPending}
                        onSave={(changes) => {
                          edit.mutate({ id: channel.id, changes });
                        }}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * Правка настроек канала.
 *
 * Отправляется **только изменившееся**: «поля нет» означает «не трогать», и это
 * не то же самое, что «очистить». Очистка номера для показа выражается явным `null` —
 * иначе правка названия однажды молча стёрла бы настроенный номер.
 */
function ChannelSettings({
  channel,
  busy,
  onSave,
}: {
  channel: Channel;
  busy: boolean;
  onSave: (changes: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(channel.name);
  const [callerId, setCallerId] = useState(channel.caller_id ?? '');
  const [recordingRequired, setRecordingRequired] = useState(channel.recording_required);

  const trimmedCaller = callerId.trim();
  const changes: Record<string, unknown> = {};
  if (name.trim() !== channel.name) changes.name = name.trim();
  if (recordingRequired !== channel.recording_required) {
    changes.recordingRequired = recordingRequired;
  }
  if (trimmedCaller !== (channel.caller_id ?? '')) {
    changes.callerId = trimmedCaller === '' ? null : trimmedCaller;
  }
  const dirty = Object.keys(changes).length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) onSave(changes);
      }}
      className="flex flex-wrap items-end gap-2"
    >
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Название</span>
        <Input
          className="w-[220px]"
          value={name}
          autoComplete="off"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Номер для показа</span>
        <Input
          className="num w-[180px]"
          inputMode="tel"
          autoComplete="off"
          spellCheck={false}
          value={callerId}
          placeholder="номер SIM"
          onChange={(event) => {
            setCallerId(event.target.value);
          }}
        />
      </label>

      <label className="flex items-center gap-2 pb-2">
        <input
          type="checkbox"
          checked={recordingRequired}
          onChange={(event) => {
            setRecordingRequired(event.target.checked);
          }}
        />
        <span>Запись разговора обязательна</span>
      </label>

      <Button type="submit" size="sm" disabled={!dirty || busy}>
        {busy ? 'Сохраняем…' : 'Сохранить'}
      </Button>

      <p className="w-full text-muted-foreground">
        Учётных данных правка не касается — регистрация АТС клиента не прервётся. Смена требования
        записи действует на последующие вызовы; включение сужает выбор партнёров, потому что шлюзы
        вида «Android» записывать не умеют. Пустой номер для показа означает «номер той SIM, с
        которой ушёл вызов».
      </p>
    </form>
  );
}
