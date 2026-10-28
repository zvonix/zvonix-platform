'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
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
import { CHANNELS_KEY, ConnectionState, StateBadge, useChannels, type Channel } from './channels';

const COLUMNS = 4;

export default function MyChannelsPage() {
  return (
    <ConsoleShell title="Линии" cabinet="client">
      {() => <MyChannels />}
    </ConsoleShell>
  );
}

/**
 * Свои линии: подключена ли программа, состояние, сколько разговоров идёт. Всё остальное — на странице линии
 * ([ADR-0101](../../../../../../docs/adr/0101-liniya-klienta-podklyuchenie-i-samoobsluzhivanie.md)).
 */
function MyChannels() {
  const queryClient = useQueryClient();
  const list = useChannels();
  // Пароль показывается один раз: хранится здесь, пока человек его не закроет.
  const [issued, setIssued] = useState<IssuedCredentials | undefined>();
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: (title: string) =>
      request<{ channel: Channel; account: SipAccount }>('/client/channels', {
        method: 'POST',
        body: title === '' ? {} : { name: title },
      }),
    onSuccess: async (data) => {
      setIssued({ title: `Доступ SIP для линии «${data.channel.name}»`, account: data.account });
      setName('');
      await queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
    },
  });

  const channels = list.data?.channels ?? [];
  const limit = list.data?.max_channels;
  const full = limit !== undefined && channels.length >= limit;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <FormDialog
          label="Получить линию"
          title="Новая линия"
          variant="outline"
          disabled={list.data === undefined || full}
        >
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
        {limit !== undefined && (
          <span className="num text-muted-foreground">
            {channels.length} из {limit}
          </span>
        )}
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

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Линия</TableHead>
              <TableHead className="h-8">Подключение</TableHead>
              <TableHead className="h-8">Состояние</TableHead>
              <TableHead className="h-8 text-right">Разговоров сейчас</TableHead>
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

            {list.data !== undefined && channels.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS} className="whitespace-normal text-muted-foreground">
                  Линий пока нет.
                </TableCell>
              </TableRow>
            )}

            {channels.map((channel) => (
              <TableRow key={channel.id}>
                <TableCell className="max-w-72 whitespace-normal">
                  <Link
                    href={`/my/channels/${channel.id}`}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {channel.name}
                  </Link>
                  {channel.comment !== null && (
                    <span className="block truncate text-faint" title={channel.comment}>
                      {channel.comment}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <ConnectionState channel={channel} />
                </TableCell>
                <TableCell>
                  <StateBadge channel={channel} />
                </TableCell>
                <TableCell className="num text-right">
                  {channel.open_calls ?? 0}
                  {channel.max_concurrent_calls !== null && (
                    <span className="text-faint"> из {channel.max_concurrent_calls}</span>
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
