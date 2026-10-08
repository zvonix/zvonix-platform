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

/**
 * Почему аккаунт недоступен — по последней сверке с провайдером: `suspended` — работа приостановлена на стороне
 * службы доставки (не оплачен, не активирован, временный запрет), `blocked` — MAX ограничил аккаунт,
 * `logged_out` — аккаунт вышел из MAX. Пусто — аккаунт рабочий или ждёт входа.
 */
export const MESSENGER_ACCOUNT_REASONS = ['suspended', 'blocked', 'logged_out'] as const;
export type MessengerAccountReason = (typeof MESSENGER_ACCOUNT_REASONS)[number];

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

/**
 * Каким путём сообщение уходит получателю ([ADR-0077](../../../docs/adr/0077-bot-max-vtoroy-kanal.md)): `account` —
 * с аккаунта партнёра, `bot` — от бота подписчику клиента.
 */
export const MESSAGE_ROUTES = ['account', 'bot'] as const;
export type MessageRoute = (typeof MESSAGE_ROUTES)[number];
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/**
 * Что наценяют правила `commission_rules` ([ADR-0073](../../../docs/adr/0073-nacenka-na-soobscheniya-pravilami.md)):
 * вызовы или сообщения MAX. Правила одни и те же, различается единица («за вызов» / «за сообщение»).
 */
export const COMMISSION_PRODUCTS = ['call', 'message'] as const;
export type CommissionProduct = (typeof COMMISSION_PRODUCTS)[number];

/** Предел доли наценки в десятитысячных: у вызовов 100 %, у сообщений 1000 %. */
export const COMMISSION_MAX_BASIS_POINTS: Record<CommissionProduct, number> = {
  call: 10_000,
  message: 100_000,
};

/**
 * Отчёты SMPP по настройкам клиента ([ADR-0076](../../../docs/adr/0076-statusy-smpp-po-nastrojkam-klienta.md)):
 * на какое событие с сообщением что отдать — ничего, `ACCEPTD` («принято») или `DELIVRD` («доставлено»).
 */
export const SMPP_RECEIPT_EVENTS = ['sent', 'delivered', 'read'] as const;
export type SmppReceiptEvent = (typeof SMPP_RECEIPT_EVENTS)[number];
export const SMPP_RECEIPT_ACTIONS = ['none', 'accepted', 'delivered'] as const;
export type SmppReceiptAction = (typeof SMPP_RECEIPT_ACTIONS)[number];
export type SmppReceiptMap = Record<SmppReceiptEvent, SmppReceiptAction>;

/** Прежнее поведение: ушло — молчим, доставлено и прочитано — `DELIVRD`. */
export const SMPP_RECEIPT_DEFAULTS: SmppReceiptMap = {
  sent: 'none',
  delivered: 'delivered',
  read: 'delivered',
};

/**
 * Бот MAX — второй канал сообщений ([ADR-0077](../../../docs/adr/0077-bot-max-vtoroy-kanal.md)).
 * `platform` — один бот площадки, `client` — бот клиента; подписчик — человек, запустивший бота по ссылке службы.
 */
export const BOT_KINDS = ['platform', 'client'] as const;
export type BotKind = (typeof BOT_KINDS)[number];
export const BOT_STATUSES = ['active', 'disabled'] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];
export const BOT_SUBSCRIBER_STATES = ['started', 'stopped'] as const;
export type BotSubscriberState = (typeof BOT_SUBSCRIBER_STATES)[number];

/** Пределы настраиваемых текстов бота клиента (ADR-0077, этап 3): приветствие и вставки до и после сообщения. */
export const BOT_GREETING_MAX = 300;
export const BOT_INSERT_MAX = 150;

/** Сколько адресов можно разрешить учётной записи SMPP: больше — это уже «любые». */
export const SMPP_ALLOWED_IPS_MAX = 20;

// --- Прогрев аккаунта и равномерная отправка ([ADR-0078](../../../docs/adr/0078-progrev-akkauntov-max.md)) ---

/** Сколько суток новый аккаунт набирает силу; потом действует потолок из тарифа. */
export const WARMUP_DAYS = 28;
/** Первые сутки: столько сообщений можно отправить с нового аккаунта. */
export const WARMUP_FIRST_DAY_LIMIT = 12;
/** К концу первой недели (седьмые сутки) аккаунт доходит до этого числа сообщений в сутки. */
export const WARMUP_WEEK_LIMIT = 100;
/** Потолок суток, когда в тарифе лимит в сутки не задан. */
export const WARMUP_DEFAULT_CEILING = 500;

/**
 * Сколько сообщений аккаунт может отправить за скользящие сутки сейчас. `day` — номер суток с начала прогрева
 * (с нуля). Первая неделя — от 12 до 100, остальное время — линейно до потолка, с 29-х суток потолок целиком.
 */
export function warmupDailyLimit(day: number, ceiling: number): number {
  if (day >= WARMUP_DAYS) return ceiling;
  const base =
    day <= 6
      ? WARMUP_FIRST_DAY_LIMIT +
        Math.round(((WARMUP_WEEK_LIMIT - WARMUP_FIRST_DAY_LIMIT) * day) / 6)
      : WARMUP_WEEK_LIMIT +
        Math.round(
          ((Math.max(ceiling, WARMUP_WEEK_LIMIT) - WARMUP_WEEK_LIMIT) * (day - 6)) /
            (WARMUP_DAYS - 6),
        );
  return Math.max(1, Math.min(ceiling, base));
}

/** Равномерность: за скользящий час уходит не больше двойной часовой доли суточного лимита, но не меньше одного. */
export function spreadHourlyLimit(daily: number): number {
  return Math.max(1, Math.ceil((daily * 2) / 24));
}
