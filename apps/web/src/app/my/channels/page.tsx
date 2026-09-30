'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelStatus } from '@zvonix/shared';
import { useState } from 'react';
import { ConfirmAction } from '@/components/confirm-action';
import { ConsoleShell } from '@/components/console-shell';
import { DialogField, DialogForm, FormDialog } from '@/components/form-dialog';
import {
  SipCredentials,
  type IssuedCredentials,
  type SipAccount,
} from '@/components/sip-credentials';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';
import { CHANNEL_STATUS_NAME, usableTone } from '@/lib/labels';
import { ChannelSettings } from './channel-settings';

const COLUMNS = 5;

interface Channel {
  readonly id: string;
  readonly name: string;
  readonly status: ChannelStatus;
  readonly recording_required: boolean;
  readonly caller_id: string | null;
}

export default function MyChannelsPage() {
  return (
    <ConsoleShell title="Мои линии" cabinet="client">
      {() => <MyChannels />}
    </ConsoleShell>
  );
}

/**
 * Свои линии клиента. «Настроить» открывает окно с порядком предложений и разрешёнными
 * операторами: у каждого списка своё сохранение, поэтому окно без общей кнопки действия.
 */
function MyChannels() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['my', 'channels'],
    queryFn: () => request<{ channels: Channel[] }>('/client/channels'),
  });
  // Пароль показывается один раз: хранится здесь, пока человек его не закроет.
  const [issued, setIssued] = useState<IssuedCredentials | undefined>();
  const [name, setName] = useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['my', 'channels'] });

  const create = useMutation({
    mutationFn: (title: string) =>
      request<{ channel: Channel; account: SipAccount }>('/client/channels', {
        method: 'POST',
        body: title === '' ? {} : { name: title },
      }),
    onSuccess: async (data) => {
      setIssued({ title: `Доступ SIP для линии «${data.channel.name}»`, account: data.account });
      setName('');
      await refresh();
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <div>
        <FormDialog label="Получить линию" title="Новая линия" variant="outline">
          <DialogForm
            submitLabel="Получить линию"
            canSubmit
            onSubmit={async () => {
              await create.mutateAsync(name.trim());
            }}
          >
            <DialogField label="Название (необязательно)" wide>
              <Input
                autoFocus
                maxLength={200}
                autoComplete="off"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </DialogField>
          </DialogForm>
        </FormDialog>
      </div>

      {issued !== undefined && (
        <SipCredentials
          title={issued.title}
          account={issued.account}
          onClose={() => {
            setIssued(undefined);
          }}
        />
      )}
      {list.error !== null && (
        <p role="alert" className="text-crit">
          {list.error.message}
        </p>
      )}

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Линия</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8">Номер для показа</TableHead>
              <TableHead className="h-8">Запись</TableHead>
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

            {list.data?.channels.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="whitespace-normal text-muted-foreground">
                  Линий пока нет.
                </TableCell>
              </TableRow>
            )}

            {list.data?.channels.map((channel) => (
              <TableRow key={channel.id}>
                <TableCell>{channel.name}</TableCell>

                <TableCell>
                  <span
                    className={`rounded-md px-2 py-0.5 ${usableTone(channel.status === 'active')}`}
                  >
                    {CHANNEL_STATUS_NAME[channel.status]}
                  </span>
                </TableCell>

                <TableCell>
                  {channel.caller_id === null ? (
                    <span className="text-faint">номер SIM, с которой ушёл вызов</span>
                  ) : (
                    <span className="num">{channel.caller_id}</span>
                  )}
                </TableCell>

                <TableCell>
                  {channel.recording_required ? (
                    'обязательна'
                  ) : (
                    <span className="text-faint">не требуется</span>
                  )}
                </TableCell>

                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    <ConfirmAction
                      label="Новый пароль"
                      title={`Новый пароль линии «${channel.name}»`}
                      consequence={
                        <p>Прежний пароль перестанет работать: АТС придётся настроить заново.</p>
                      }
                      confirmLabel="Выдать новый пароль"
                      onConfirm={async () => {
                        const data = await request<{ account: SipAccount }>(
                          `/client/channels/${channel.id}/credentials`,
                          { method: 'POST' },
                        );
                        setIssued({
                          title: `Новый доступ SIP для линии «${channel.name}»`,
                          account: data.account,
                        });
                      }}
                    />
                    <FormDialog
                      label="Настроить"
                      variant="outline"
                      title={`Настройки линии «${channel.name}»`}
                      description="Порядок предложений и разрешённые операторы сохраняются каждый своей кнопкой."
                      wide
                    >
                      <div className="min-h-0 overflow-y-auto px-5 pb-5">
                        <ChannelSettings channelId={channel.id} />
                      </div>
                    </FormDialog>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
