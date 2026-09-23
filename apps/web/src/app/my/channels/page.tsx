'use client';

import { useQuery } from '@tanstack/react-query';
import type { ChannelStatus } from '@zvonix/shared';
import { Fragment, useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { Button } from '@/components/ui/button';
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

function MyChannels() {
  const [opened, setOpened] = useState<string | undefined>(undefined);

  const list = useQuery({
    queryKey: ['my', 'channels'],
    queryFn: () => request<{ channels: Channel[] }>('/client/channels'),
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">
        Линия — это ваше SIP-подключение к площадке. Название, номер для показа и требование записи
        задаёт площадка; порядок партнёров и разрешённых операторов — вы сами.
      </p>

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
                  Линий пока нет — значит, звонить неоткуда. Их заводит площадка вместе с доступом
                  SIP: напишите в поддержку.
                </TableCell>
              </TableRow>
            )}

            {list.data?.channels.map((channel) => (
              <Fragment key={channel.id}>
                <TableRow>
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
                    <Button
                      variant="outline"
                      size="sm"
                      aria-expanded={opened === channel.id}
                      onClick={() => {
                        setOpened(opened === channel.id ? undefined : channel.id);
                      }}
                    >
                      {opened === channel.id ? 'Свернуть' : 'Настроить'}
                    </Button>
                  </TableCell>
                </TableRow>

                {opened === channel.id && (
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={COLUMNS} className="whitespace-normal">
                      <ChannelSettings channelId={channel.id} />
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
