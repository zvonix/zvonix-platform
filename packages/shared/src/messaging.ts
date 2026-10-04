/**
 * Сообщения в мессенджере MAX ([ADR-0071](../../../docs/adr/0071-soobscheniya-max.md)).
 *
 * Провайдер доступа к мессенджеру — внутренняя деталь площадки: в кабинетах и API для партнёров и
 * клиентов он не называется, а здесь значения перечислений лежат только для базы и кода.
 */

/** Кто даёт доступ к мессенджеру. `simulated` — для разработки и проверок, без внешних вызовов. */
export const MESSENGER_PROVIDERS = ['green_api', 'simulated'] as const;
export type MessengerProviderId = (typeof MESSENGER_PROVIDERS)[number];

/**
 * Состояние аккаунта MAX у партнёра.
 *
 * `pending`     — заведён, QR-код ещё не отсканирован: отправлять нечем;
 * `active`      — вошёл и на связи: принимает сообщения;
 * `unavailable` — вышел из MAX или провайдер не отвечает: сообщения не отправляются, вернуться
 *                 в `active` можно сканированием QR-кода или когда связь восстановится;
 * `retired`     — списан партнёром; необратимо (на аккаунт ссылаются отправленные сообщения).
 */
export const MESSENGER_ACCOUNT_STATUSES = ['pending', 'active', 'unavailable', 'retired'] as const;
export type MessengerAccountStatus = (typeof MESSENGER_ACCOUNT_STATUSES)[number];

/** Сообщение принимает только `active`. */
export const SENDABLE_ACCOUNT_STATUSES: readonly MessengerAccountStatus[] = ['active'];

/** Предел длины текста: столько принимает мессенджер за одно сообщение. */
export const MESSAGE_MAX_LENGTH = 4000;

/** Цена партнёра за одно сообщение, в рублях: меньше копейки нет смысла, больше сотни — опечатка. */
export const MESSAGE_PRICE_MIN_RUBLES = '0.01';
export const MESSAGE_PRICE_MAX_RUBLES = '100';

/** Предел значения лимита аккаунта (в минуту, в сутки): выше — опечатка, а не лимит. */
export const MESSENGER_LIMIT_MAX = 1_000_000;

/** Аккаунтов MAX у одного партнёра — столько же, сколько у него шлюзов по умолчанию. */
export const MESSENGER_ACCOUNTS_PER_PARTNER_MAX = 20;
