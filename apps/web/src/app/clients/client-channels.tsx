'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CHANNEL_STATUSES, type ChannelStatus } from '@zvonix/shared';
import { KeyRound, Settings } from 'lucide-react';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { StatusDialog } from '@/components/status-dialog';
import { ChannelPassword } from '@/components/channel-password';
import { StatusDot } from '@/components/status-dot';
import { HEAD, RowActions, ROW_ICON, TABLE_FRAME, WIDE_ONLY } from '@/components/table-parts';
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
import { channelState } from '@/lib/channel-state';
import { CHANNEL_STATUS_MEANING, CHANNEL_STATUS_NAME } from '@/lib/labels';

interface Channel {
  readonly id: string;
  readonly name: string;
  readonly status: ChannelStatus;
  /** Кто выключил: клиент сам или площадка (ADR-0101). */
  readonly suspended_by: 'client' | 'admin' | null;
  readonly sip_username: string;
  readonly recording_required: boolean;
  readonly caller_id: string | null;
  /** Комментарий клиента (ADR-0101). */
  readonly comment: string | null;
  readonly connection: { readonly connected: boolean; readonly address: string | null };
  /** Хранится ли пароль для показа (ADR-0124). */
  readonly has_secret: boolean;
  readonly last_call_at?: string | null;
}

const COLUMNS = 6;

/** Удаляет линию только клиент: у площадки для этого есть «Приостановить» (ADR-0101). */
const ADMIN_STATUSES = CHANNEL_STATUSES.filter((status) => status !== 'closed');

/**
 * Кнопка называет действие, а не состояние: «Приостановлен» рядом с плашкой текущего
 * состояния читалось как ещё одна плашка.
 */
const CHANNEL_ACTION: Record<Exclude<ChannelStatus, 'closed'>, string> = {
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
            label="Добавить канал"
            variant="outline"
            title="Новый канал"
            description="После добавления кабинет один раз покажет имя и пароль SIP."
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

      <div className={TABLE_FRAME}>
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className={HEAD}>Канал</TableHead>
              <TableHead className={HEAD}>Состояние</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Имя SIP</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Запись</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Номер для показа</TableHead>
              <TableHead className={`${HEAD} w-px`}>
                <span className="sr-only">Действия</span>
              </TableHead>
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
                <TableCell>
                  {/* Комментарий клиента — в подсказке к названию: строка в одну линию (DESIGN.md, «Таблица»). */}
                  <span
                    className="inline-block max-w-72 truncate align-bottom"
                    title={channel.comment ?? channel.name}
                  >
                    {channel.name}
                  </span>
                </TableCell>
                <TableCell>
                  {/*
                    Одно «Состояние» с подключением, как у клиента (lib/channel-state.ts; владелец, 2026-11-18: две
                    колонки рядом — «Работает» и «Не подключена» — нелогично).
                  */}
                  <ChannelStateCell channel={channel} />
                </TableCell>
                <TableCell className={WIDE_ONLY}>
                  <span className="num" translate="no">
                    {channel.sip_username}
                  </span>
                </TableCell>
                <TableCell className={WIDE_ONLY}>
                  {channel.recording_required ? (
                    'обязательна'
                  ) : (
                    <span className="text-muted-foreground">не нужна</span>
                  )}
                </TableCell>
                <TableCell className={WIDE_ONLY}>
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
                  {canChange && channel.status !== 'closed' && (
                    <RowActions>
                      <StatusDialog
                        subject={`канал «${channel.name}»`}
                        current={CHANNEL_STATUS_NAME[channel.status]}
                        disabled={busy}
                        options={ADMIN_STATUSES.filter((status) => status !== channel.status).map(
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
                        label={<Settings aria-hidden className="size-4" />}
                        tooltip="Настроить"
                        {...ROW_ICON}
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
                        label={<KeyRound aria-hidden className="size-4" />}
                        tooltip="Новый доступ"
                        {...ROW_ICON}
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
                    </RowActions>
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
      submitLabel="Добавить канал"
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

      {/* Пароль — посмотреть, не изменить: менять — значком «Новый доступ» в строке (ADR-0124). */}
      <div className="flex flex-col gap-1 sm:col-span-2">
        <span className="font-medium">Пароль SIP</span>
        <ChannelPassword
          endpoint={`/channels/${channel.id}/secret`}
          hasSecret={channel.has_secret}
        />
      </div>

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

/** Состояние канала одним словом — тем же расчётом, что у клиента, словами администратора. */
function ChannelStateCell({ channel }: { channel: Channel }) {
  const state = channelState(channel, 'admin');
  return <StatusDot tone={state.tone} label={state.label} reason={state.reason} phoneDot />;
}
