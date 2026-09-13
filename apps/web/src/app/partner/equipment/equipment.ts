/**
 * Оборудование партнёра — вид ответа `GET /partner/equipment`.
 *
 * Отдельным файлом, а не внутри страницы: те же имена нужны разделу вызовов, где
 * идентификатор шлюза и SIM превращается в название и номер. Второй список имён
 * разъехался бы с первым на первой же правке контракта.
 */

import type { GatewayPortState, GatewayStatus, GatewayType, SimStatus } from '@zvonix/shared';

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

interface Port {
  readonly id: string;
  readonly port_number: number;
  readonly state: GatewayPortState;
  readonly sim: Sim | null;
}

export interface Gateway {
  readonly id: string;
  readonly name: string;
  readonly type: GatewayType;
  readonly status: GatewayStatus;
  readonly model: string | null;
  /**
   * Есть ли регистрация на узле. Без неё вызов не уйдёт вовсе: диалплан набирает шлюз
   * как зарегистрированного пользователя, и отбор кандидатов сужается узлом.
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

export interface Equipment {
  readonly gateways: readonly Gateway[];
  readonly trunks: readonly Trunk[];
  readonly spare_sims: readonly Sim[];
}

/** Все карты партнёра: и стоящие в портах, и лежащие отдельно. */
export function simsOf(equipment: Equipment | undefined): Sim[] {
  if (equipment === undefined) return [];
  const inPorts = equipment.gateways.flatMap((gateway) =>
    gateway.ports.flatMap((port) => (port.sim === null ? [] : [port.sim])),
  );
  return [...inPorts, ...equipment.spare_sims];
}
