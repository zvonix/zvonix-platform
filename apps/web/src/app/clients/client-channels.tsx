'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CHANNEL_STATUSES, type ChannelStatus } from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { StatusDialog } from '@/components/status-dialog';
import { ErrorNote } from '@/components/error-note';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import type { IssuedCredentials, SipAccount } from '@/components/sip-credentials';
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
 * Состояние меняется окном с вариантами (`StatusDialog`), перевыпуск доступа — через
 * подтверждение с последствием: раньше оба срабатывали с первого нажатия, а перевыпуск
 * молча обрывал регистрацию АТС клиента (ui-review, 2026-09-14). Заведение и настройка —
 * окна ([DESIGN.md](../../../../../docs/DESIGN.md), «Окно, страница или панель»).
 *
 * Выданный пароль уходит наверх (`onIssued`) и показывается над разделами карточки:
 * окно заведения закрывается успехом и унесло бы панель с собой, а второго показа нет.
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

  const list = useQuery({
    queryKey: ['channels', clientId],
    queryFn: () => request<{ channels: Channel[] }>(`/channels?clientId=${clientId}`),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['channels', clientId] });
  };

  const create = useMutation({
    mutationFn: (draft: ChannelDraft) =>
      request<{ account: SipAccount }>('/channels', {
        method: 'POST',
        body: {
          clientId,
          name: draft.name,
          recordingRequired: draft.recordingRequired,
          ...(draft.callerId === '' ? {} : { callerId: draft.callerId }),
        },
      }),
    onSuccess: async (data, draft) => {
      onIssued({ title: `Доступ SIP для канала «${draft.name}»`, account: data.account });
      await invalidate();
    },
  });

  // Действия над линией — своими мутациями: их отказ показывается в их окне
  // и не повторяется в общей строке ошибок.
  const changeStatus = useMutation({
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
    onSuccess: invalidate,
  });

  // Отказы действий показывают их окна, здесь — только отказ списка.
  const failed = asApiError(list.error);
  const channels = list.data?.channels ?? [];
  const busy = changeStatus.isPending || reissue.isPending;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h2 className="font-semibold">Каналы</h2>
        {canChange && (
          <FormDialog
            label="Завести канал"
            variant="outline"
            title="Новый канал"
            description="После заведения кабинет один раз покажет имя и пароль SIP."
          >
            <NewChannelForm onCreate={(draft) => create.mutateAsync(draft)} />
          </FormDialog>
        )}
      </div>

      {list.data !== undefined && channels.length === 0 && (
        <p className="text-warn">
          Каналов нет — клиенту нечем подключиться к платформе и не с чего звонить.
        </p>
      )}

      {failed !== undefined && <ErrorNote error={failed} />}

      <div className="overflow-x-auto rounded-md border border-border bg-card">
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
              <TableRow key={channel.id}>
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
                      <StatusDialog
                        subject={`канал «${channel.name}»`}
                        current={CHANNEL_STATUS_NAME[channel.status]}
                        disabled={busy}
                        options={CHANNEL_STATUSES.filter((status) => status !== channel.status).map(
                          (status) => ({
                            value: status,
                            action: CHANNEL_ACTION[status],
                            meaning: CHANNEL_STATUS_MEANING[status],
                            danger: status !== 'active',
                          }),
                        )}
                        onChange={(status) => changeStatus.mutateAsync({ id: channel.id, status })}
                      />
                      <FormDialog
                        label="Настроить"
                        variant="outline"
                        title={`Настройки канала «${channel.name}»`}
                        description="Учётных данных правка не касается — регистрация АТС клиента не прервётся."
                      >
                        <ChannelSettings
                          channel={channel}
                          onSave={(changes) => edit.mutateAsync({ id: channel.id, changes })}
                        />
                      </FormDialog>
                      {/*
                        Пароль SIP восстановить неоткуда, а утёкший пароль канала — это
                        чужие вызовы за счёт клиента. Без перевыпуска единственным ответом
                        на утечку было бы отключение канала целиком.
                      */}
                      <ConfirmAction
                        label="Новый доступ"
                        title={`Перевыпустить доступ канала «${channel.name}»`}
                        consequence={
                          <>
                            <p>
                              Имя и пароль SIP меняются сразу. АТС клиента потеряет регистрацию и не
                              сможет звонить по этой линии, пока в неё не введут новые данные.
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
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

interface ChannelDraft {
  readonly name: string;
  readonly callerId: string;
  readonly recordingRequired: boolean;
}

/** Поля окна «Новый канал». Монтируются только открытым окном — каждый раз пустые. */
function NewChannelForm({ onCreate }: { onCreate: (draft: ChannelDraft) => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [callerId, setCallerId] = useState('');
  const [recordingRequired, setRecordingRequired] = useState(false);

  const trimmedName = name.trim();
  const nameValid = trimmedName.length >= 2;

  return (
    <DialogForm
      submitLabel="Завести канал"
      canSubmit={nameValid}
      onSubmit={() => onCreate({ name: trimmedName, callerId: callerId.trim(), recordingRequired })}
    >
      <DialogField label="Название">
        <Input
          value={name}
          autoComplete="off"
          autoFocus
          placeholder="Диспетчерская"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="Номер для показа">
        <Input
          className="num"
          inputMode="tel"
          autoComplete="off"
          spellCheck={false}
          value={callerId}
          placeholder="номер SIM"
          onChange={(event) => {
            setCallerId(event.target.value);
          }}
        />
      </DialogField>

      <RecordingField checked={recordingRequired} onChange={setRecordingRequired} />

      {name !== '' && !nameValid && (
        <p className="text-warn sm:col-span-2">Название — не короче двух знаков.</p>
      )}

      <p className="text-muted-foreground sm:col-span-2">
        {/*
          ADR-0012: на шлюзе типа `android` запись технически невозможна, и такой
          канал туда не маршрутизируется вовсе. Сказать это при заведении дешевле,
          чем разбирать потом «почему через этого партнёра не звонит».
        */}
        Канал заведётся в состоянии «ждёт»: доступ SIP выдан, но звонки не пойдут, пока вы не
        переведёте его в «работает». Канал с обязательной записью не уйдёт на шлюзы вида «Android» —
        там запись невозможна, и выбор партнёров у такого канала уже. Пустой номер для показа
        означает «номер той SIM, с которой ушёл вызов».
      </p>
    </DialogForm>
  );
}

/**
 * Правка настроек канала — поля окна «Настроить».
 *
 * Отправляется **только изменившееся**: «поля нет» означает «не трогать», и это
 * не то же самое, что «очистить». Очистка номера для показа выражается явным `null` —
 * иначе правка названия однажды молча стёрла бы настроенный номер.
 */
function ChannelSettings({
  channel,
  onSave,
}: {
  channel: Channel;
  onSave: (changes: Record<string, unknown>) => Promise<unknown>;
}) {
  const [name, setName] = useState(channel.name);
  const [callerId, setCallerId] = useState(channel.caller_id ?? '');
  const [recordingRequired, setRecordingRequired] = useState(channel.recording_required);

  const trimmedName = name.trim();
  const trimmedCaller = callerId.trim();
  const changes: Record<string, unknown> = {};
  if (trimmedName !== channel.name) changes.name = trimmedName;
  if (recordingRequired !== channel.recording_required) {
    changes.recordingRequired = recordingRequired;
  }
  if (trimmedCaller !== (channel.caller_id ?? '')) {
    changes.callerId = trimmedCaller === '' ? null : trimmedCaller;
  }
  const dirty = Object.keys(changes).length > 0;
  const nameValid = trimmedName.length >= 2;

  return (
    <DialogForm
      submitLabel="Сохранить"
      canSubmit={dirty && nameValid}
      onSubmit={() => onSave(changes)}
    >
      <DialogField label="Название">
        <Input
          value={name}
          autoComplete="off"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </DialogField>

      <DialogField label="Номер для показа">
        <Input
          className="num"
          inputMode="tel"
          autoComplete="off"
          spellCheck={false}
          value={callerId}
          placeholder="номер SIM"
          onChange={(event) => {
            setCallerId(event.target.value);
          }}
        />
      </DialogField>

      <RecordingField checked={recordingRequired} onChange={setRecordingRequired} />

      {!nameValid && <p className="text-warn sm:col-span-2">Название — не короче двух знаков.</p>}

      <p className="text-muted-foreground sm:col-span-2">
        Смена требования записи действует на последующие вызовы; включение сужает выбор партнёров,
        потому что шлюзы вида «Android» записывать не умеют. Пустой номер для показа означает «номер
        той SIM, с которой ушёл вызов».
      </p>
    </DialogForm>
  );
}

function RecordingField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 sm:col-span-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span>Запись разговора обязательна</span>
    </label>
  );
}
