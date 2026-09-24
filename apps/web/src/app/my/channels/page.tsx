'use client';

import { useQuery } from '@tanstack/react-query';
import type { ChannelStatus } from '@zvonix/shared';
import { ConsoleShell } from '@/components/console-shell';
import { FormDialog } from '@/components/form-dialog';
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
                  Линий пока нет — значит, звонить неоткуда. Их добавляет площадка вместе с доступом
                  SIP: напишите в поддержку.
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
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
