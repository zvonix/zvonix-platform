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

/**
 * Состояние SIM-карты (жизненный цикл в DOMAIN.md).
 *
 * `new`       — заведена партнёром, в работу не пущена;
 * `active`    — принимает вызовы;
 * `throttled` — временно придержана: подошла к лимиту или просела по ASR.
 *               Возвращается в `active` сама, когда показатели восстановились;
 * `blocked`   — заблокирована оператором или администратором. Сама не возвращается;
 * `retired`   — выведена навсегда. Запись остаётся: на неё ссылаются CDR.
 */
export const SIM_STATUSES = ['new', 'active', 'throttled', 'blocked', 'retired'] as const;
export type SimStatus = (typeof SIM_STATUSES)[number];

/** Состояния, в которых SIM годится для вызова. */
export const USABLE_SIM_STATUSES: readonly SimStatus[] = ['active'];

/**
 * Куда SIM может звонить по своему тарифу.
 *
 * В v1 значение одно: **все партнёры работают на безлимите внутри своей сети**,
 * и на этом построена экономика платформы (ADR-0013). Перечисление заведено с одним
 * значением намеренно — чтобы «только своя сеть» было записано явно, а не подразумевалось
 * молчанием. Появится SIM с внесетевыми минутами — добавится значение, и маршрутизация
 * обязана будет его учесть.
 */
export const SIM_NETWORK_SCOPES = ['own_network'] as const;
export type SimNetworkScope = (typeof SIM_NETWORK_SCOPES)[number];

/**
 * Состояние порта шлюза.
 *
 * `unknown`  — порт объявлен, но оборудование о нём ещё не отчиталось;
 * `idle`     — свободен;
 * `busy`     — занят вызовом;
 * `fault`    — оборудование сообщило о неисправности;
 * `disabled` — выключен человеком: партнёром или администратором.
 *
 * Первые четыре проставляет агент узла по данным оборудования, последнее — человек.
 * Пока агента нет, порт остаётся в `unknown`, и это **не** повод его не использовать:
 * «о состоянии не отчитались» и «неисправен» — разные утверждения.
 */
export const GATEWAY_PORT_STATES = ['unknown', 'idle', 'busy', 'fault', 'disabled'] as const;
export type GatewayPortState = (typeof GATEWAY_PORT_STATES)[number];

/** Состояния порта, при которых на него допустимо направить вызов. */
export const USABLE_PORT_STATES: readonly GatewayPortState[] = ['unknown', 'idle'];

/**
 * Сколько вызовов SIM обслуживает одновременно.
 *
 * По умолчанию один. Инвариант DOMAIN.md: значение меняет **только администратор** —
 * превышение это прямой путь к блокировке SIM оператором, а партнёр заинтересован
 * поднять его и не увидеть последствий сразу.
 */
export const DEFAULT_MAX_CONCURRENT_CALLS = 1;
export const MAX_CONCURRENT_CALLS_LIMIT = 8;
