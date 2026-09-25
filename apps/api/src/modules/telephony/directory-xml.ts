/**
 * Сборка ответов FreeSWITCH для привязки `directory` (docs/api/node.md).
 *
 * Ответ обязан быть **валидным XML и с кодом 200 всегда**: любой другой код `mod_xml_curl`
 * отбрасывает целиком и пишет ошибку в лог, а «пользователь не найден» — это штатный
 * ответ, а не сбой. Отсюда отдельный документ для отсутствующей записи.
 */

import { escapeXmlAttribute } from './sip-credentials.js';

const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>';

/**
 * «Записи нет» на языке FreeSWITCH.
 *
 * Отдаётся и когда учётной записи не существует, и когда она есть, но отключена:
 * заблокированный партнёр не должен по разнице ответов узнавать, что его шлюз
 * ещё числится в системе.
 */
export function notFoundDocument(): string {
  return [
    HEADER,
    '<document type="freeswitch/xml">',
    '  <section name="result">',
    '    <result status="not found"/>',
    '  </section>',
    '</document>',
  ].join('\n');
}

export interface DirectoryUser {
  /** Имя учётной записи SIP: `gw-a1b2c3d4e5f6`. */
  readonly username: string;
  /** `MD5(имя:realm:пароль)`. Открытого пароля здесь нет и быть не должно. */
  readonly a1Hash: string;
  /** Переменные канала, которые FreeSWITCH проставит на вызовах этой записи. */
  readonly variables: Readonly<Record<string, string>>;
}

/**
 * Куда звонить учётной записи — то, что `user/<имя>@<домен>` превращает в вызов.
 *
 * Без этого параметра `user/…` отвечает `MANDATORY_IE_MISSING` сразу, до набора: запись
 * найдена, а строки набора у неё нет. Так упал первый тестовый звонок на живом узле
 * (2026-09-25) — и так же падал бы каждый вызов клиента на GOIP: диалплан набирает шлюз
 * тем же `user/…`. Штатный каталог FreeSWITCH задаёт эту строку на домене; у нас домен
 * приходит из control plane вместе с записью, поэтому она здесь.
 *
 * Значение — штатное FreeSWITCH: `sofia_contact` находит адрес, с которого устройство
 * зарегистрировалось. `^^:` меняет разделитель переменных на двоеточие, чтобы запятая
 * внутри значений не резала список.
 */
const DIAL_STRING =
  '{^^:sip_invite_domain=${dialed_domain}:presence_id=${dialed_user}@${dialed_domain}}' +
  '${sofia_contact(*/${dialed_user}@${dialed_domain})}';

/**
 * Документ `directory` с одной учётной записью.
 *
 * `a1-hash` вместо `password`: FreeSWITCH принимает готовый хеш и не считает его сам,
 * поэтому открытый пароль не покидает control plane — и не появляется в нём вовсе.
 */
export function directoryDocument(domain: string, user: DirectoryUser): string {
  const variables = Object.entries(user.variables)
    .map(
      ([name, value]) =>
        `          <variable name="${escapeXmlAttribute(name)}" value="${escapeXmlAttribute(value)}"/>`,
    )
    .join('\n');

  return [
    HEADER,
    '<document type="freeswitch/xml">',
    '  <section name="directory">',
    `    <domain name="${escapeXmlAttribute(domain)}">`,
    `      <user id="${escapeXmlAttribute(user.username)}">`,
    '        <params>',
    `          <param name="a1-hash" value="${escapeXmlAttribute(user.a1Hash)}"/>`,
    `          <param name="dial-string" value="${escapeXmlAttribute(DIAL_STRING)}"/>`,
    '        </params>',
    '        <variables>',
    variables,
    '        </variables>',
    '      </user>',
    '    </domain>',
    '  </section>',
    '</document>',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
