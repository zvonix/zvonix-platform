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

/**
 * Состояние сообщения.
 *
 * `queued`    — принято, деньги списаны, ждёт отправки (лимиты, пауза);
 * `sending`   — взято в работу воркером;
 * `sent`      — ушло в мессенджер;
 * `delivered` — доставлено получателю;
 * `read`      — прочитано;
 * `failed`    — окончательно не отправлено, деньги возвращены.
 */
export const MESSAGE_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * Почему сообщение не отправлено — **наши** причины, не слова провайдера (ADR-0071):
 * `recipient_not_in_max` — у номера нет аккаунта MAX; `account_unavailable` — аккаунт вышел из MAX или
 * не отвечал; `wait_expired` — ждало отправки дольше допустимого; `platform` — наша сторона.
 */
export const MESSAGE_FAILURE_REASONS = [
  'recipient_not_in_max',
  'account_unavailable',
  'wait_expired',
  'platform',
] as const;
export type MessageFailureReason = (typeof MESSAGE_FAILURE_REASONS)[number];

/** Сколько раз пробуем отправить при временных сбоях, прежде чем вернуть деньги. */
export const MESSAGE_MAX_ATTEMPTS = 5;

/**
 * Каким путём сообщение принято ([ADR-0072](../../../docs/adr/0072-smpp-dlya-soobscheniy.md)).
 * От пути зависит только одно: по `smpp` клиенту отдаётся отчёт о доставке (`deliver_sm`).
 */
export const MESSAGE_CHANNELS = ['api', 'smpp'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/** Сколько адресов можно разрешить учётной записи SMPP: больше — это уже «любые». */
export const SMPP_ALLOWED_IPS_MAX = 20;
