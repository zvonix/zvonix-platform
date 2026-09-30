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
    // Префикс нужен и при входе по линиям: GOIP в Config by Line набирает номер из звонка,
    // только если тот начинается с Routing Prefix линии; звонок на сам вход линии он
    // принимает как двухступенчатый — отвечает сразу и ждёт номер тоном (живой GOIP,
    // 2026-09-29).
    return { sipUsername: port.sipUsername, linePrefix: goipLinePrefix(port.portNumber) };
  }
  return { sipUsername: gateway.sipUsername, linePrefix: goipLinePrefix(port.portNumber) };
}

/**
 * Строка набора для FreeSWITCH: `[zvonix_dial=<префикс><номер>]user/<вход>@realm`.
 *
 * Куда и что набирать, решает строка набора из каталога (`directory-xml.ts`, `dial-string`):
 * она берёт адрес регистрации входа (`sofia_contact`) и ставит в него вместо имени входа
 * `zvonix_dial`. Получается `sip:99004+<номер>@<адрес GOIP>` — запрос уходит прямо на GOIP,
 * а номер с префиксом линии стоит там, где GOIP его читает.
 *
 * Как к этому пришли на живом узле (2026-09-25…29): номер в адресе запроса с realm уходил
 * на сам узел; номер в `To` GOIP не читал и ждал тонового набора; номер без префикса
 * на адрес линии получал `404`. Работает только префикс линии в адресе запроса на GOIP.
 *
 * Не экранирована: диалплан экранирует её под XML сам, команде ESL экранирование
 * не нужно — имя, префикс и номер здесь только из букв, цифр и дефиса.
 */
export function simEndpoint(target: SimDialTarget, destination: string, realm: string): string {
  // «+» перед номером: SIM набирает его в сеть как есть, и `79230189196` без плюса сеть
  // отклоняет (`404`), а `+79230189196` соединяет — так набирает и сам GOIP (живой GOIP,
  // 2026-09-29: с плюсом звонок прошёл). Префикс линии GOIP отрезает, плюс остаётся.
  const dialled = `${target.linePrefix ?? ''}+${destination}`;
  return `[zvonix_dial=${dialled}]user/${target.sipUsername}@${realm}`;
}

/**
 * Адрес набора для `bridge` в диалплане: номер стоит в самой строке, без переменной плеча.
 *
 * Тот же результат, что у `simEndpoint` (`sofia/zvonix/sip:99004+<номер>@<адрес GOIP>`),
 * но иным путём. Переменная плеча `[zvonix_dial=…]` доходит до строки набора каталога
 * при `originate` из ESL (тестовый звонок) и **не доходит из `bridge` диалплана**: строка
 * набора раскрывается в контексте вызывающего плеча, где переменной нет. На живом узле
 * (2026-09-30) вызов клиента ушёл на `sofia/zvonix/@<адрес>` — пустое имя вместо
 * `99004+<номер>` — и 32 секунды звонил в пустоту. Здесь номер — литерал внутри выражения,
 * которое узел раскрывает при выполнении `bridge`; выражение то же, что в
 * `directory-xml.ts`, и проверено на узле через `eval`.
 *
 * Не зарегистрирован — `sofia_contact` отдаёт `error/user_not_registered`, выражение его не
 * трогает, и `bridge` падает с `USER_NOT_REGISTERED`, как и раньше.
 */
export function simBridgeEndpoint(
  target: SimDialTarget,
  destination: string,
  realm: string,
): string {
  const dialled = `${target.linePrefix ?? ''}+${destination}`;
  return (
    `\${regex(\${sofia_contact(*/${target.sipUsername}@${realm})}` +
    `|^(sofia/[^/]+/)sip:[^@]+(@.*)$|%1sip:${dialled}%2)}`
  );
}
