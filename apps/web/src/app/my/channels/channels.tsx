'use client';

import { useQuery } from '@tanstack/react-query';
import type { ChannelStatus, ChannelSuspendedBy } from '@zvonix/shared';
import { StatusDot, type StatusTone } from '@/components/status-dot';
import { request } from '@/lib/api';
import { channelState } from '@/lib/channel-state';

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
  /** Хранится ли пароль для показа (ADR-0124): нет — выдан до обновления. */
  readonly has_secret: boolean;
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
  readonly server: string | null;
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

/** Клиент сам распоряжается линией: работающей или выключенной им же. */
export function ownedByClient(channel: Pick<Channel, 'status' | 'suspended_by'>): boolean {
  return (
    channel.status === 'active' ||
    (channel.status === 'suspended' && channel.suspended_by === 'client')
  );
}

/**
 * Состояние линии в строке таблицы — одна точка и одно слово (`channelState`): «Подключена», «Работает», «Ждёт
 * программу», «Выключена»… Подробности — в подсказке ([DESIGN.md](../../../../../../docs/DESIGN.md), «Таблица»).
 */
export function ChannelStateDot({ channel }: { channel: Channel }) {
  const state = channelState(channel, 'client');
  return <StatusDot tone={state.tone} label={state.label} reason={state.reason} />;
}

/** То же меткой — в шапке страницы одной линии (DESIGN.md, «Окно, страница или панель», исключение). */
export function ChannelStateBadge({ channel }: { channel: Channel }) {
  const state = channelState(channel, 'client');
  return (
    <span className={`rounded-md px-2 py-0.5 ${BADGE[state.tone]}`} title={state.reason}>
      {state.label}
    </span>
  );
}

const BADGE: Record<StatusTone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  crit: 'bg-crit-soft text-crit',
  off: 'bg-muted text-muted-foreground',
};
