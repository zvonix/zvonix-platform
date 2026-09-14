/**
 * Перечисления телефонии: шлюзы партнёров и каналы клиентов (ADR-0009, ADR-0012).
 */

/**
 * Вид шлюза.
 *
 * `goip`      — аппаратный GSM-шлюз с портами под SIM;
 * `android`   — телефон партнёра с приложением ([ADR-0012](../../docs/adr/0012-mobilnoe-prilozhenie.md)).
 *               **Запись разговора на нём технически невозможна**, поэтому канал
 *               с требованием записи на такой шлюз не маршрутизируется никогда;
 * `sip_trunk` — соединение с транзитным оператором
 *               ([ADR-0039](../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
 *               Ни SIM, ни портов: ёмкость меряется числом одновременных вызовов,
 *               а регистрация идёт **в обратную сторону** — не он к нам, а мы к нему.
 */
export const GATEWAY_TYPES = ['goip', 'android', 'sip_trunk'] as const;
export type GatewayType = (typeof GATEWAY_TYPES)[number];

/**
 * Шлюзы, на которых запись разговора возможна.
 *
 * Отображение, а не условие: новый вид шлюза не соберётся, пока про запись на нём
 * не сказано прямо. Умолчание «можно» было бы опаснее — канал с обязательной записью
 * ушёл бы туда, где её не будет, и узнали бы об этом при запросе записи.
 *
 * У транка запись возможна: её делает **узел**, а не оборудование партнёра.
 */
const RECORDING_BY_GATEWAY: Record<GatewayType, boolean> = {
  goip: true,
  android: false,
  sip_trunk: true,
};

export function supportsRecording(type: GatewayType): boolean {
  return RECORDING_BY_GATEWAY[type];
}

/**
 * Способ терминации — **через что вызов физически уходит с площадки**
 * ([ADR-0040](../../docs/adr/0040-poryadok-terminacii-predlozhenie-i-cena.md)).
 *
 * `sim` — по воздуху через SIM партнёра в порту шлюза;
 * `sip` — по интернету через транзитного оператора
 *         ([ADR-0039](../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
 *
 * Это **измерение цены**, а не характеристика железа: внутри своей сети SIM почти
 * бесплатна, транзит платный всегда, и разница между ними — в разы. Клиенту незачем
 * знать, GOIP у партнёра или телефон, — это его оборудование; а «по воздуху или через
 * интернет» знать нужно, потому что от этого зависит, сколько клиент платит.
 */
export const TERMINATION_KINDS = ['sim', 'sip'] as const;
export type TerminationKind = (typeof TERMINATION_KINDS)[number];

/**
 * Каким способом терминирует шлюз этого вида.
 *
 * Отображение, а не условие: сегодня все виды шлюзов про SIM, и `if` здесь имел бы
 * недостижимую ветвь. Запись через `Record` заодно **не даст забыть** про новый вид —
 * добавление `sip_trunk` (ADR-0039) не соберётся, пока его сюда не внесли.
 */
const TERMINATION_BY_GATEWAY: Record<GatewayType, TerminationKind> = {
  goip: 'sim',
  android: 'sim',
  sip_trunk: 'sip',
};

export function terminationKindOf(type: GatewayType): TerminationKind {
  return TERMINATION_BY_GATEWAY[type];
}

/**
 * Состояние шлюза.
 *
 * `pending`   — заведён партнёром, модерация не пройдена: учётная запись SIP не выдаётся;
 * `active`    — регистрируется и принимает вызовы;
 * `suspended` — выключен: самим партнёром, администратором или порогом отказов.
 *               Кто именно — `GATEWAY_SUSPENDED_BY`, от этого зависит, кто вправе вернуть;
 * `retired`   — выведен навсегда. Запись остаётся: на шлюз ссылаются CDR.
 */
export const GATEWAY_STATUSES = ['pending', 'active', 'suspended', 'retired'] as const;
export type GatewayStatus = (typeof GATEWAY_STATUSES)[number];

/**
 * Кто выключил шлюз. Задан ровно у `suspended`
 * ([ADR-0047](../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md)).
 *
 * `partner`           — сам партнёр: он же и включает обратно, и списывает;
 * `admin`             — администратор площадки: рычаг против злоупотребления;
 * `failure_threshold` — порог отказов сети ([ADR-0027](../../../docs/adr/0027-porog-otklyucheniya.md)).
 *
 * Состояние отвечает на вопрос «идут ли вызовы», источник — «кто вправе вернуть».
 * Отдельное состояние `paused` смешало бы одно с другим и не различило бы админа и порог.
 */
export const GATEWAY_SUSPENDED_BY = ['partner', 'admin', 'failure_threshold'] as const;
export type GatewaySuspendedBy = (typeof GATEWAY_SUSPENDED_BY)[number];

/** Состояние шлюза целиком: `suspended` без источника и источник без `suspended` не записать. */
export type GatewayState =
  | { readonly status: 'suspended'; readonly suspendedBy: GatewaySuspendedBy }
  | { readonly status: Exclude<GatewayStatus, 'suspended'>; readonly suspendedBy: null };

/**
 * Источник отключения, каким его видит партнёр.
 *
 * Администратор схлопнут в `platform`: кто именно на площадке выключил — не вопрос
 * партнёра. Порог показан отдельно: с ним партнёру есть что делать — проверить
 * оборудование. Чисел порога он не видит, качество ему закрыто.
 */
export type PartnerFacingSuspension = 'partner' | 'platform' | 'failure_threshold';

/** Через `Record`: новый источник не соберётся, пока не решено, как его видит партнёр. */
const PARTNER_FACING_SUSPENSION: Record<GatewaySuspendedBy, PartnerFacingSuspension> = {
  partner: 'partner',
  admin: 'platform',
  failure_threshold: 'failure_threshold',
};

export function partnerFacingSuspension(by: GatewaySuspendedBy): PartnerFacingSuspension {
  return PARTNER_FACING_SUSPENSION[by];
}

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
 * `throttled` — придержана площадкой: порогом отказов сети или администратором.
 *               Сама не возвращается, и партнёр её не снимает — только администратор
 *               ([ADR-0027](../../../docs/adr/0027-porog-otklyucheniya.md),
 *               [ADR-0047](../../../docs/adr/0047-kto-vyklyuchil-shlyuz.md));
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

/**
 * Сколько вызовов одновременно держит SIP-транк
 * ([ADR-0039](../../docs/adr/0039-terminaciya-cherez-sip-trank.md)).
 *
 * Пределы у транка другие, чем у SIM, и по другой причине. У SIM ограничение
 * от **оператора**: восемь одновременных вызовов с одной карты — уже нечеловеческий
 * профиль, за который карту блокируют. У транка ограничение **договорное**: провайдер
 * продаёт ёмкость каналами, и их бывает и тридцать, и триста.
 *
 * Умолчание намеренно скромное: превышение купленной ёмкости провайдер отвергает,
 * и вызовы срываются молча.
 */
export const DEFAULT_TRUNK_CONCURRENT_CALLS = 10;
export const MAX_TRUNK_CONCURRENT_CALLS = 1000;

/**
 * Область действия порога отключения
 * ([ADR-0027](../../../docs/adr/0027-porog-otklyucheniya.md)).
 *
 * Канала здесь нет намеренно: вызовы канала срываются, как правило, из-за номерной базы
 * клиента, а не из-за неисправности, и автоматически отключить платящего клиента —
 * решение с прямыми последствиями для выручки.
 */
export const FAILURE_SCOPES = ['sim', 'gateway'] as const;
export type FailureScope = (typeof FAILURE_SCOPES)[number];

/**
 * Состояние, в которое порог переводит объект своей области.
 *
 * Оба обратимы и снимают объект с маршрутизации. Настраиваемого действия у порога нет:
 * возможность выбрать `retired` означала бы, что администратор одним неверным полем
 * выводит SIM из эксплуатации навсегда.
 */
export const SCOPE_SUSPENDED_STATUS: Readonly<Record<FailureScope, string>> = {
  sim: 'throttled',
  gateway: 'suspended',
};
