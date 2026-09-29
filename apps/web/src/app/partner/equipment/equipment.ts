/**
 * Оборудование партнёра — вид ответа `GET /partner/equipment`.
 *
 * Отдельным файлом, а не внутри страницы: те же имена нужны разделу вызовов, где
 * идентификатор шлюза и SIM превращается в название и номер. Второй список имён
 * разъехался бы с первым на первой же правке контракта.
 */

import type {
  GatewayPortState,
  GatewayRegistrationMode,
  GatewayStatus,
  GatewayType,
  PartnerFacingSuspension,
  PartnerStatus,
  SimStatus,
} from '@zvonix/shared';
import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { GATEWAY_STATUS_NAME, PARTNER_SUSPENSION_NAME } from '@/lib/labels';

export interface Sim {
  readonly id: string;
  readonly msisdn: string;
  readonly status: SimStatus;
  readonly operator_id: string;
  readonly operator_name: string | null;
  readonly max_concurrent_calls: number;
  /** Пусто — оператор карты не подтверждён источником; карта при этом включается и звонит. */
  readonly operator_confirmed_at: string | null;
}

export interface Port {
  readonly id: string;
  readonly port_number: number;
  readonly state: GatewayPortState;
  readonly sim: Sim | null;
  /** Вход линии при входе по линиям (ADR-0054); пусто — не выдан. Пароль не отдаётся. */
  readonly sip_username: string | null;
  /** Есть ли у линии регистрация. Значимо только при входе по линиям. */
  readonly on_node: boolean;
  readonly registered_at: string | null;
}

export interface Gateway {
  readonly id: string;
  readonly name: string;
  readonly type: GatewayType;
  readonly status: GatewayStatus;
  /**
   * Кто выключил (ADR-0047): `partner` партнёр снимает сам, `platform`
   * и `failure_threshold` — нет. Задан ровно у `suspended`.
   */
  readonly suspended_by: PartnerFacingSuspension | null;
  readonly model: string | null;
  /** `port` — у каждой линии свой вход, `gateway` — один вход на шлюз (ADR-0054). */
  readonly registration_mode: GatewayRegistrationMode;
  /** Имя SIP, под которым шлюз регистрируется. Пароль не отдаётся никогда. */
  readonly sip_username: string;
  /**
   * Есть ли регистрация на узле. Без неё вызов не уйдёт вовсе: диалплан набирает шлюз
   * как зарегистрированного пользователя, и отбор кандидатов сужается узлом.
   * При входе по линиям — есть ли она хоть у одной линии.
   */
  readonly on_node: boolean;
  readonly registered_at: string | null;
  readonly ports: readonly Port[];
}

interface Trunk {
  readonly id: string;
  readonly name: string;
  readonly status: GatewayStatus;
  readonly proxy_host: string;
  readonly registers_outbound: boolean;
  readonly outbound_username: string | null;
  readonly max_concurrent_calls: number;
  readonly on_node: boolean;
}

/** Куда регистрировать шлюз — одно на всех. */
export interface Connection {
  readonly server: string;
  readonly port: number;
}

export interface Equipment {
  readonly connection: Connection;
  readonly gateways: readonly Gateway[];
  readonly trunks: readonly Trunk[];
  readonly spare_sims: readonly Sim[];
}

/** Ключ оборудования в кэше: список, страница шлюза и вызовы читают один ответ. */
export const EQUIPMENT_KEY = ['partner', 'equipment'] as const;

/** Все карты партнёра: и стоящие в портах, и лежащие отдельно. */
export function simsOf(equipment: Equipment | undefined): Sim[] {
  if (equipment === undefined) return [];
  const inPorts = equipment.gateways.flatMap((gateway) =>
    gateway.ports.flatMap((port) => (port.sim === null ? [] : [port.sim])),
  );
  return [...inPorts, ...equipment.spare_sims];
}

/**
 * Состояние шлюза словами партнёра: у выключенного важнее, кто выключил (ADR-0047).
 * `pending` — «Не включён»: «Ждёт» читалось как «ждёт площадку», хотя включает сам
 * партнёр (владелец, 2026-09-25).
 */
export function gatewayStateName(gateway: Gateway): string {
  if (gateway.status === 'pending') return 'Не включён';
  return gateway.suspended_by === null
    ? GATEWAY_STATUS_NAME[gateway.status]
    : PARTNER_SUSPENSION_NAME[gateway.suspended_by];
}

/**
 * Почему шлюзы не подключаются, если дело не в них: пока площадка не допустила партнёра,
 * каталог отвечает узлу «нет такого входа», и никакие логины в GOIP не помогут. Владелец
 * искал ошибку в GOIP часами, а кабинет советовал проверить пароли (2026-09-25).
 */
export const PARTNER_BLOCKED: Readonly<Record<Exclude<PartnerStatus, 'verified'>, string>> = {
  pending:
    'Площадка ещё не допустила вас к работе: шлюзы не подключатся и карты не получат звонков, ' +
    'пока администратор не проверит вашу карточку. Логины и пароли в GOIP здесь ни при чём.',
  suspended:
    'Площадка приостановила вашу работу: шлюзы не подключаются. Напишите площадке, чтобы узнать причину.',
  closed: 'Ваша карточка партнёра закрыта: шлюзы не подключаются.',
};

/**
 * Состояние карточки партнёра. Ключ тот же, что у страницы «Деньги»: запрос общий, кэш тоже.
 * `undefined` — ещё не загрузилось: предупреждать не о чем, пока не знаем.
 */
export function usePartnerStatus(): PartnerStatus | undefined {
  const account = useQuery({
    queryKey: ['partner', 'account'],
    queryFn: () => request<{ partner: { status: PartnerStatus } }>('/partner/account'),
  });
  return account.data?.partner.status;
}
