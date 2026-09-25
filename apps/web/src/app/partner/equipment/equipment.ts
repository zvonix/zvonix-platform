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
  SimStatus,
} from '@zvonix/shared';
import { GATEWAY_STATUS_NAME, PARTNER_SUSPENSION_NAME } from '@/lib/labels';

export interface Sim {
  readonly id: string;
  readonly msisdn: string;
  readonly status: SimStatus;
  readonly operator_id: string;
  readonly operator_name: string | null;
  readonly max_concurrent_calls: number;
  /** Пусто — оператор карты не подтверждён. Такая карта вызовов не получает. */
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

/** Состояние шлюза словами партнёра: у выключенного важнее, кто выключил (ADR-0047). */
export function gatewayStateName(gateway: Gateway): string {
  return gateway.suspended_by === null
    ? GATEWAY_STATUS_NAME[gateway.status]
    : PARTNER_SUSPENSION_NAME[gateway.suspended_by];
}
