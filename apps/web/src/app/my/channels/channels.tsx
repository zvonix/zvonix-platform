'use client';

import { useQuery } from '@tanstack/react-query';
import type { ChannelStatus, ChannelSuspendedBy } from '@zvonix/shared';
import { request } from '@/lib/api';
import { moment } from '@/lib/format';

/**
 * Линии клиента — общее для списка и страницы линии
 * ([ADR-0101](../../../../../../docs/adr/0101-liniya-klienta-podklyuchenie-i-samoobsluzhivanie.md)).
 */

export interface Channel {
  readonly id: string;
  readonly name: string;
  readonly status: ChannelStatus;
  readonly suspended_by: ChannelSuspendedBy | null;
  readonly recording_required: boolean;
  readonly comment: string | null;
  readonly max_concurrent_calls: number | null;
  readonly sip_username: string;
  readonly connection: {
    readonly connected: boolean;
    readonly seen_at: string | null;
    readonly address: string | null;
  };
  readonly open_calls?: number;
  readonly last_call_at?: string | null;
}

export interface ChannelList {
  readonly channels: readonly Channel[];
  readonly server: string;
  readonly max_channels: number;
}

export const CHANNELS_KEY = ['my', 'channels'] as const;

/** Подключение меняется само — список перечитывается раз в 30 секунд, пока страница открыта. */
const CHANNELS_REFRESH_MS = 30_000;

export function useChannels() {
  return useQuery({
    queryKey: CHANNELS_KEY,
    queryFn: () => request<ChannelList>('/client/channels'),
    refetchInterval: CHANNELS_REFRESH_MS,
  });
}

/** Состояние глазами клиента: кто выключил — от этого зависит, включит ли он сам. */
function channelStateName(channel: Pick<Channel, 'status' | 'suspended_by'>): string {
  switch (channel.status) {
    case 'active':
      return 'Работает';
    case 'pending':
      return 'Ждёт площадку';
    case 'suspended':
      return channel.suspended_by === 'client' ? 'Выключена' : 'Выключена площадкой';
    case 'closed':
      return 'Удалена';
  }
}

/** Клиент сам распоряжается линией: работающей или выключенной им же. */
export function ownedByClient(channel: Pick<Channel, 'status' | 'suspended_by'>): boolean {
  return (
    channel.status === 'active' ||
    (channel.status === 'suspended' && channel.suspended_by === 'client')
  );
}

export function StateBadge({ channel }: { channel: Pick<Channel, 'status' | 'suspended_by'> }) {
  return (
    <span
      className={`rounded-md px-2 py-0.5 ${channel.status === 'active' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}
    >
      {channelStateName(channel)}
    </span>
  );
}

/**
 * Подключена ли программа. Выключенной линии подключаться некуда — прочерк. Не подключена, но звонила — время
 * последнего вызова: программа без регистрации звонит и так, и «сломана» было бы неправдой (ADR-0101, п. 2).
 */
export function ConnectionState({ channel }: { channel: Channel }) {
  if (channel.status !== 'active') return <span className="text-faint">—</span>;
  if (channel.connection.connected) {
    return (
      <span className="flex flex-col">
        <span className="text-ok">Подключена</span>
        {channel.connection.address !== null && (
          <span className="num text-faint" translate="no">
            {channel.connection.address}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="flex flex-col">
      <span className="text-warn">Не подключена</span>
      {channel.last_call_at != null && (
        <span className="text-faint">вызов {moment(channel.last_call_at)}</span>
      )}
    </span>
  );
}
