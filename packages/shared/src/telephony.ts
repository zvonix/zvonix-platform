/**
 * Перечисления телефонии: шлюзы партнёров и каналы клиентов (ADR-0009, ADR-0012).
 */

/**
 * Вид шлюза.
 *
 * `goip`    — аппаратный GSM-шлюз с портами под SIM;
 * `android` — телефон партнёра с приложением ([ADR-0012](../../docs/adr/0012-mobilnoe-prilozhenie.md)).
 *             **Запись разговора на нём технически невозможна**, поэтому канал
 *             с требованием записи на такой шлюз не маршрутизируется никогда.
 */
export const GATEWAY_TYPES = ['goip', 'android'] as const;
export type GatewayType = (typeof GATEWAY_TYPES)[number];

/** Шлюзы, на которых запись разговора возможна. */
export function supportsRecording(type: GatewayType): boolean {
  return type === 'goip';
}

/**
 * Состояние шлюза.
 *
 * `pending`   — заведён партнёром, модерация не пройдена: учётная запись SIP не выдаётся;
 * `active`    — регистрируется и принимает вызовы;
 * `suspended` — временно отключён администратором или автоматикой по порогу неудач;
 * `retired`   — выведен навсегда. Запись остаётся: на шлюз ссылаются CDR.
 */
export const GATEWAY_STATUSES = ['pending', 'active', 'suspended', 'retired'] as const;
export type GatewayStatus = (typeof GATEWAY_STATUSES)[number];

/**
 * Состояния, в которых шлюзу выдаётся учётная запись SIP.
 *
 * Всё держится на этом списке: заблокировали партнёра — его шлюз перестаёт
 * регистрироваться при следующей попытке, без раскатки конфигурации на узлы.
 */
export const REGISTRABLE_GATEWAY_STATUSES: readonly GatewayStatus[] = ['active'];

/**
 * Состояние канала клиента.
 *
 * `pending`   — заведён, вызовы не принимает;
 * `active`    — работает;
 * `suspended` — отключён: нет денег, превышены лимиты, решение администратора.
 */
export const CHANNEL_STATUSES = ['pending', 'active', 'suspended'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export const ACTIVE_CHANNEL_STATUSES: readonly ChannelStatus[] = ['active'];

/**
 * Имя учётной записи SIP: `gw-<12 символов>` у шлюза, `ch-<12 символов>` у канала.
 *
 * Не идентификатор сущности: он попадает в заголовки SIP, в логи узла и в запись
 * регистрации, а UUID там нечитаем. И не имя, заданное человеком: оно меняется,
 * а смена имени учётной записи означает перенастройку оборудования у партнёра.
 */
const SIP_USERNAME = /^(gw|ch)-[0-9a-z]{12}$/;

export function isSipUsername(value: string): boolean {
  return SIP_USERNAME.test(value);
}
