/**
 * Как набрать линию с SIM — одно правило для маршрутизации и тестового звонка
 * ([ADR-0053](../../../../../docs/adr/0053-liniya-goip-po-prefiksu.md),
 * [ADR-0054](../../../../../docs/adr/0054-vhod-po-liniyam-goip.md),
 * [ADR-0055](../../../../../docs/adr/0055-testovyy-zvonok-s-sim.md)).
 *
 * Одно, а не два: тестовый звонок, набирающий линию иначе, чем площадка набирает её
 * для клиента, проверял бы не то, чем звонит площадка.
 */

import { goipLinePrefix, type GatewayRegistrationMode, type GatewayType } from '@zvonix/shared';

export interface SimDialTarget {
  /** Учётная запись, которую набирать: вход линии (`pt-…`) или шлюза (`gw-…`). */
  readonly sipUsername: string;
  /** Префикс линии GOIP при входе на шлюз; пусто — линию уже выбрал вход. */
  readonly linePrefix: string | null;
}

/**
 * Кого набирать и с каким префиксом.
 *
 * При входе по линиям — учётной записью самой линии, без префикса; при входе на шлюз —
 * префиксом линии. У телефона Android слот один — набирается шлюз как есть.
 */
export function simDialTarget(
  gateway: {
    readonly type: GatewayType;
    readonly registrationMode: GatewayRegistrationMode;
    readonly sipUsername: string;
  },
  port: { readonly id: string; readonly portNumber: number; readonly sipUsername: string | null },
): SimDialTarget {
  if (gateway.type !== 'goip') {
    return { sipUsername: gateway.sipUsername, linePrefix: null };
  }
  if (gateway.registrationMode === 'port') {
    // Пустое имя здесь — рассогласование данных, и набирать вместо линии шлюз целиком
    // значило бы позвонить с неизвестной SIM.
    if (port.sipUsername === null) {
      throw new Error(`У порта ${port.id} нет входа линии, а набирают именно его`);
    }
    return { sipUsername: port.sipUsername, linePrefix: null };
  }
  return { sipUsername: gateway.sipUsername, linePrefix: goipLinePrefix(port.portNumber) };
}

/**
 * Строка набора для FreeSWITCH: `[sip_invite_req_uri=sip:<набор>@realm]user/<имя>@realm`.
 *
 * `user/…` находит регистрацию — куда слать INVITE, но в строке запроса оставляет имя
 * учётной записи. Номер с префиксом линии кладётся туда переменной плеча.
 *
 * Не экранирована: диалплан экранирует её под XML сам, команде ESL экранирование
 * не нужно — имя, префикс и номер здесь только из букв, цифр и дефиса.
 */
export function simEndpoint(target: SimDialTarget, destination: string, realm: string): string {
  const dialled = `${target.linePrefix ?? ''}${destination}`;
  return `[sip_invite_req_uri=sip:${dialled}@${realm}]user/${target.sipUsername}@${realm}`;
}
