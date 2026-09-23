'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { isStaffRole, type Cabinet, type ClientStatus, type PartnerStatus } from '@zvonix/shared';
import { request } from './api';
import { useSession } from './session';

/** Карточки вошедшего — ответ `GET /me/cabinets` ([ADR-0052](../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)). */
export interface OwnedCabinets {
  readonly client: {
    readonly id: string;
    readonly name: string;
    readonly status: ClientStatus;
  } | null;
  readonly partner: {
    readonly id: string;
    readonly display_name: string | null;
    readonly status: PartnerStatus;
  } | null;
}

/**
 * Какие кабинеты открыты вошедшему.
 *
 * Сотруднику площадки не запрашивается вовсе: кабинетов у него не бывает, и лишний
 * запрос на каждой странице админки ничего бы не сказал.
 */
export function useCabinets(): UseQueryResult<OwnedCabinets> {
  const session = useSession();
  const role = session.data?.role;
  return useQuery({
    queryKey: ['me', 'cabinets'],
    queryFn: async () => (await request<{ cabinets: OwnedCabinets }>('/me/cabinets')).cabinets,
    enabled: role !== undefined && !isStaffRole(role),
    staleTime: 60_000,
  });
}

/** Домашняя страница кабинета: первый вопрос у обоих — «что с моими звонками». */
export const CABINET_HOME: Record<Cabinet, string> = {
  client: '/my/calls',
  partner: '/partner/calls',
};

/**
 * Кабинет, к которому относится страница, — по её адресу.
 *
 * Кабинет не хранится ни в сессии, ни на сервере: две вкладки с разными кабинетами
 * работают одновременно и не мешают друг другу (ADR-0052).
 */
export function cabinetOfPath(pathname: string): Cabinet | undefined {
  if (pathname === '/my' || pathname.startsWith('/my/')) return 'client';
  if (pathname === '/partner' || pathname.startsWith('/partner/')) return 'partner';
  return undefined;
}

const LAST_CABINET_KEY = 'zvonix.last-cabinet';

/**
 * Последний открытый кабинет — удобство одного браузера, а не состояние площадки.
 * Хранилище бывает недоступно (приватное окно, запрет сайта) — тогда просто нет памяти.
 */
export function rememberCabinet(cabinet: Cabinet): void {
  try {
    window.localStorage.setItem(LAST_CABINET_KEY, cabinet);
  } catch {
    // Память о кабинете — удобство: без хранилища домашней станет первый кабинет.
  }
}

function lastCabinet(): Cabinet | undefined {
  try {
    const value = window.localStorage.getItem(LAST_CABINET_KEY);
    return value === 'client' || value === 'partner' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Куда вести вошедшего участника: последний кабинет, если он ещё есть, иначе первый. */
export function homeCabinet(owned: OwnedCabinets): Cabinet | undefined {
  const last = lastCabinet();
  if (last !== undefined && owned[last] !== null) return last;
  if (owned.client !== null) return 'client';
  if (owned.partner !== null) return 'partner';
  return undefined;
}
