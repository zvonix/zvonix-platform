/**
 * Исходящие sofia-gateway узла — готовым файлом для FreeSWITCH
 * ([ADR-0118](../../../../../docs/adr/0118-uzel-zabiraet-tranki-gotovym-xml.md)).
 *
 * Собирает площадка, а не узел: на узле только shell без `jq`, и экранировать там чужие пароли
 * и имена — значит рано или поздно сломать XML. Узел кладёт ответ в `zvonix-gateways/` как есть.
 *
 * **Один транк — одна строка.** По строке узел решает, какой sofia-gateway изменился или пропал
 * и его надо снять (`killgw`): сравнение строк — то, что shell делает надёжно.
 */

import { escapeXmlAttribute } from './sip-credentials.js';

export interface NodeSipGateway {
  readonly name: string;
  /** `sip.provider.ru` либо `sip.provider.ru:5070`. */
  readonly proxyHost: string;
  readonly registersOutbound: boolean;
  readonly username: string | null;
  readonly password: string | null;
}

/**
 * Имя учётной записи, когда провайдер узнаёт нас по адресу: FreeSWITCH без `username`
 * не поднимает gateway вовсе («username param is REQUIRED»), даже без регистрации.
 */
const UNREGISTERED_USERNAME = 'zvonix';

/** Повтор регистрации при отказе провайдера, с — не чаще, чтобы не попасть в его бан. */
const RETRY_SECONDS = 30;

/** Срок регистрации у провайдера, с. */
const EXPIRE_SECONDS = 600;

export function sipGatewaysXml(gateways: readonly NodeSipGateway[]): string {
  return ['<include>', ...gateways.map(gatewayLine), '</include>', ''].join('\n');
}

function gatewayLine(gateway: NodeSipGateway): string {
  // Домен учётной записи — адрес провайдера без порта: иначе FreeSWITCH возьмёт имя gateway
  // (`gw-…`), и провайдер не узнает свой домен в From и Request-URI.
  const realm = gateway.proxyHost.replace(/:[0-9]+$/u, '');
  const registers = gateway.registersOutbound;
  const params: [string, string][] = [
    ['proxy', gateway.proxyHost],
    ['realm', realm],
    ['register', registers ? 'true' : 'false'],
    ['username', registers ? (gateway.username ?? '') : UNREGISTERED_USERNAME],
    ['password', registers ? (gateway.password ?? '') : ''],
    ['expire-seconds', String(EXPIRE_SECONDS)],
    ['retry-seconds', String(RETRY_SECONDS)],
    ['caller-id-in-from', 'false'],
  ];
  const body = params
    .map(([name, value]) => `<param name="${name}" value="${attribute(value)}"/>`)
    .join('');
  return `<gateway name="${attribute(gateway.name)}">${body}</gateway>`;
}

/** Атрибут без переводов строк: перевод внутри пароля разорвал бы правило «один транк — одна строка». */
function attribute(value: string): string {
  return escapeXmlAttribute(value).replace(
    /[\t\n\r]/gu,
    (char) => `&#${String(char.charCodeAt(0))};`,
  );
}
