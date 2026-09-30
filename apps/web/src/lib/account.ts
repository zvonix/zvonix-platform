'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ClientStatus, PartnerStatus } from '@zvonix/shared';
import { request } from './api';

/**
 * Счёт клиента — ответ `GET /client/account`.
 *
 * Запрос один на шапку кабинета и на страницу «Деньги»: у них общий ключ, а значит и
 * общая форма данных. Две страницы с одним ключом и разными формами уронили «Мои линии»
 * (2026-09-30), поэтому запрос живёт здесь, а не в каждой странице.
 */
export interface ClientAccount {
  readonly client: { id: string; name: string; status: ClientStatus; created_at: string };
  readonly funds: {
    readonly balance: string;
    readonly overdraft_limit: string;
    readonly held: string;
    readonly available: string;
  };
}

/** Счёт партнёра — ответ `GET /partner/account`. */
export interface PartnerAccount {
  readonly partner: {
    readonly id: string;
    readonly name: string;
    readonly display_name: string | null;
    readonly status: PartnerStatus;
    readonly listens_to_recordings: boolean;
    readonly created_at: string;
  };
  readonly funds: { readonly balance: string };
}

/** Остаток меняется с каждым вызовом; минута — чтобы шапка не показывала вчерашнее. */
const REFRESH_MS = 60_000;

export function useClientAccount(enabled = true): UseQueryResult<ClientAccount> {
  return useQuery({
    queryKey: ['my', 'account'],
    queryFn: () => request<ClientAccount>('/client/account'),
    enabled,
    refetchInterval: REFRESH_MS,
  });
}

export function usePartnerAccount(enabled = true): UseQueryResult<PartnerAccount> {
  return useQuery({
    queryKey: ['partner', 'account'],
    queryFn: () => request<PartnerAccount>('/partner/account'),
    enabled,
    refetchInterval: REFRESH_MS,
  });
}
