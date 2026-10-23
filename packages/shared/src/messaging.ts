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

/**
 * Строка, которую площадка добавляет в конец сообщения через аккаунт партнёра, если у аккаунта включена «строка про СТОП»
 * ([ADR-0088](../../../docs/adr/0088-otchety-i-zashchita-akkauntov-max.md)). Одна на всех: так ответ «СТОП» узнаётся однозначно.
 */
export const STOP_LINE = 'Чтобы отписаться, ответьте СТОП';

/** Цена партнёра за одно сообщение, в рублях: меньше копейки нет смысла, больше сотни — опечатка. */
export const MESSAGE_PRICE_MIN_RUBLES = '0.01';
export const MESSAGE_PRICE_MAX_RUBLES = '100';

/** Предел значения лимита аккаунта (в минуту, в сутки): выше — опечатка, а не лимит. */
export const MESSENGER_LIMIT_MAX = 1_000_000;

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
 * не отвечал; `wait_expired` — ждало отправки дольше допустимого; `platform` — наша сторона;
 * `recipient_stopped` — получатель ответил «СТОП» ([ADR-0088](../../../docs/adr/0088-otchety-i-zashchita-akkauntov-max.md)).
 */
export const MESSAGE_FAILURE_REASONS = [
  'recipient_not_in_max',
  'account_unavailable',
  'wait_expired',
  'platform',
  'recipient_stopped',
  /** Срок вышел, а провайдер пробовал отправить и не смог: «MAX не ответил вовремя» (ADR-0098). */
  'provider_timeout',
] as const;

/**
 * Почему сообщение не принято ([ADR-0098](../../../docs/adr/0098-otklonyonnye-pri-priyome.md)) — `details.reason` отказа при приёме;
 * без своей причины — `other`.
 */
export const MESSAGE_REFUSAL_REASONS = [
  'all_busy',
  'no_capacity',
  'recipient_not_in_max',
  'recipient_inactive',
  'recipient_stopped',
  'duplicate_message',
  'recipient_limit',
  'insufficient_funds',
  'requirements_unmet',
  'bot_only',
  'other',
] as const;
export type MessageRefusalReason = (typeof MESSAGE_REFUSAL_REASONS)[number];

/**
 * События аккаунта для истории ([ADR-0088](../../../docs/adr/0088-otchety-i-zashchita-akkauntov-max.md)): стал недоступен (с причиной
 * из `MESSENGER_ACCOUNT_REASONS`), вернулся в работу, поставлен на паузу здоровья.
 */
export const MESSENGER_ACCOUNT_EVENT_KINDS = ['unavailable', 'active', 'health_paused'] as const;
export type MessengerAccountEventKind = (typeof MESSENGER_ACCOUNT_EVENT_KINDS)[number];

/** Итог настоящего запроса «есть ли у номера MAX» к провайдеру. */
export const NUMBER_CHECK_RESULTS = ['exists', 'absent', 'unknown', 'limited'] as const;
export type NumberCheckResult = (typeof NUMBER_CHECK_RESULTS)[number];

/** Откуда номер попал в список «не писать»: ответ на аккаунт партнёра или «СТОП» боту. */
/** Требование клиента к строке «СТОП» у аккаунта ([ADR-0092](../../../docs/adr/0092-trebovaniya-klienta-k-akkauntam.md)). */
export const STOP_LINE_REQUIREMENTS = ['any', 'required', 'forbidden'] as const;
export type StopLineRequirement = (typeof STOP_LINE_REQUIREMENTS)[number];
/** Предел требования «аккаунт работает не меньше N суток». */
export const ACCOUNT_MIN_AGE_DAYS_MAX = 365;

export const MESSAGE_STOP_SOURCES = ['account', 'bot'] as const;
export type MessageStopSource = (typeof MESSAGE_STOP_SOURCES)[number];
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
/**
 * Ответ программе клиента на событие с сообщением. `enroute` — промежуточный ENROUTE («в пути»): программа ждёт дальше, поэтому он
 * допустим только на «ушло» (владелец, 2026-10-23: «чтобы программа видела, когда отправлено»; ADR-0076, ревизия).
 */
export const SMPP_RECEIPT_ACTIONS = ['none', 'enroute', 'accepted', 'delivered'] as const;
/** Окончательные ответы: на «доставлено» и «прочитано» промежуточный не имеет смысла. */
export const SMPP_RECEIPT_FINAL_ACTIONS = ['none', 'accepted', 'delivered'] as const;
export type SmppReceiptAction = (typeof SMPP_RECEIPT_ACTIONS)[number];
export type SmppReceiptMap = Record<SmppReceiptEvent, SmppReceiptAction>;

/**
 * Журнал подключения SMPP ([ADR-0096](../../../docs/adr/0096-zhurnal-podklyucheniy-smpp.md)): вход и отказ в приёме сообщения.
 * Неизвестное имя для входа в журнал не попадает — его не к чему привязать.
 */
export const SMPP_EVENT_KINDS = ['bind', 'submit'] as const;
export type SmppEventKind = (typeof SMPP_EVENT_KINDS)[number];
/** Итог входа: принят или почему отклонён. Программе уходит общий код, подробность — только в журнал. */
export const SMPP_BIND_RESULTS = [
  'ok',
  'wrong_password',
  'ip_not_allowed',
  'disabled',
  'product_off',
  'client_inactive',
  'too_many_sessions',
  /** Адрес на минуту не пускается за подбор пароля — пишется один раз, когда пауза началась. */
  'ip_blocked',
  /** Такого имени входа нет — строка журнала площадки без подключения, с введённым именем (ADR-0096, дополнение 2026-10-23). */
  'unknown_login',
] as const;
export type SmppBindResult = (typeof SMPP_BIND_RESULTS)[number];
/** Почему сообщение не принято. Номер и текст в журнал не пишутся — это персональные данные. */
export const SMPP_SUBMIT_REFUSALS = [
  'invalid_destination',
  'invalid_length',
  'invalid_validity',
  'wrong_mode',
  /** Отклонено по причине, у которой нет своего значения ниже. */
  'rejected',
  'throttled',
  'system_error',
  /**
   * Точные причины отказа сервиса (`details.reason`) — чтобы по строке журнала было видно, что случилось, а не «нет MAX, деньги,
   * требования…» одной группой (владелец, 2026-10-23).
   */
  'recipient_not_in_max',
  'recipient_inactive',
  'recipient_stopped',
  'duplicate_message',
  'recipient_limit',
  'insufficient_funds',
  'requirements_unmet',
] as const;
export type SmppSubmitRefusal = (typeof SMPP_SUBMIT_REFUSALS)[number];
export const SMPP_BIND_MODES = ['transmitter', 'receiver', 'transceiver'] as const;
export type SmppBindMode = (typeof SMPP_BIND_MODES)[number];
/** Сколько суток хранится журнал подключения. */
export const SMPP_EVENTS_KEEP_DAYS = 30;

/**
 * Что делать с сообщением, если свободного аккаунта сейчас нет ([ADR-0097](../../../docs/adr/0097-zanyato-i-srok-soobshcheniya.md)):
 * `reject` — отказать сразу (программа уйдёт к другому агрегатору), `wait` — ждать в очереди до срока. Не задано — по каналу.
 */
export const MESSAGE_BUSY_MODES = ['reject', 'wait'] as const;
export type MessageBusyMode = (typeof MESSAGE_BUSY_MODES)[number];
/** Предел «сколько ждать» и срока у сообщения, минут: сутки. */
export const MESSAGE_WAIT_MINUTES_MAX = 1440;

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

/** Ответ бота человеку, когда он запустил бота, если клиент не задал свой; `{название}` — название службы клиента. */
export const BOT_START_DEFAULT = 'Служба «{название}» будет присылать вам уведомления в этом чате.';
/**
 * Надпись кнопки под ответом при запуске (она отправляет MAX номер человека) — по умолчанию; площадка меняет её настройкой
 * `bot.share_button`. Надпись говорит, что человек получит, а не что он отдаёт: что номер уйдёт службе, MAX переспросит сам.
 */
export const BOT_SHARE_BUTTON = '📲 Получать уведомления';
/** Предел надписи кнопки: длинная не помещается в кнопку на телефоне. */
export const BOT_SHARE_BUTTON_MAX = 30;
/**
 * Призыв нажать кнопку — площадка добавляет его к ответу при запуске всегда, через пустую строку: без номера бот писать не
 * может, а свой текст клиента мог о кнопке не сказать (владелец, 2026-10-22). Он же — ответ человеку, который пишет боту, так
 * и не поделившись номером. Надпись кнопки в нём не повторяется: она настраивается, а «кнопка ниже» верна при любой.
 */
export const BOT_SHARE_CALL = 'Нажмите кнопку ниже 👇, чтобы получать уведомления.';

/** Только буквы и цифры в нижнем регистре: «📲 Получать уведомления» и «получать уведомления» — одна надпись. */
const lettersOf = (value: string): string =>
  value
    .toLocaleLowerCase('ru')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Что бот отвечает при запуске, по частям: текст клиента (своего нет — стандартный) и призыв нажать кнопку. Подставляется
 * `{название}` и прежний `{служба}` (старые тексты не ломаются). Призыва нет, если текст сам называет кнопку — не повторяем
 * (прежняя надпись «Поделиться номером» тоже считается: старые тексты клиентов её называют). Одна функция и для бота, и для
 * предпросмотра в кабинете: показанное совпадает с ушедшим.
 */
export function botStartParts(
  custom: string | null,
  company: string,
  button: string = BOT_SHARE_BUTTON,
): { text: string; call: string | null } {
  const text = (custom ?? BOT_START_DEFAULT)
    .replaceAll('{название}', company)
    .replaceAll('{служба}', company);
  const plain = lettersOf(text);
  const mentionsButton = [button, 'Поделиться номером'].some((label) => {
    const name = lettersOf(label);
    return name !== '' && plain.includes(name);
  });
  return { text, call: mentionsButton ? null : BOT_SHARE_CALL };
}

/** Ответ при запуске целиком — как его получит человек. */
export function botStartText(
  custom: string | null,
  company: string,
  button: string = BOT_SHARE_BUTTON,
): string {
  const { text, call } = botStartParts(custom, company, button);
  return call === null ? text : `${text}\n\n${call}`;
}

/** Сколько адресов можно разрешить учётной записи SMPP: больше — это уже «любые». */
export const SMPP_ALLOWED_IPS_MAX = 20;

// --- Прогрев аккаунта и равномерная отправка ([ADR-0078](../../../docs/adr/0078-progrev-akkauntov-max.md)) ---

/** Почему аккаунт стоит на паузе ([ADR-0079](../../../docs/adr/0079-raspredelenie-soobscheniy-i-zdorove-akkauntov.md)): MAX часто сообщает «нет аккаунта» уже после отправки. */
export const MESSENGER_PAUSE_REASONS = ['absent_rate'] as const;
export type MessengerPauseReason = (typeof MESSENGER_PAUSE_REASONS)[number];

// --- Распределение, которое выбирает партнёр ([ADR-0080](../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)) ---

/** К чему относится настройка: звонки (`call`) или сообщения MAX (`message`). */
export const DISTRIBUTION_PRODUCTS = ['call', 'message'] as const;
export type DistributionProduct = (typeof DISTRIBUTION_PRODUCTS)[number];

/**
 * Как выбирается следующая карта или аккаунт среди допустимых: `equal` — давно не работавшая; `remaining` — с
 * наибольшим остатком суточного лимита; `sequential` — по порядку в списке, пока не упрётся в предел; `weighted` —
 * доли трафика по весам; `priority` — по приоритету, внутри одного — поровну.
 */
export const DISTRIBUTION_MODES = [
  'equal',
  'remaining',
  'sequential',
  'weighted',
  'priority',
] as const;
export type DistributionMode = (typeof DISTRIBUTION_MODES)[number];

/** Запас лимита, который не расходуется, не больше этого процента. */
export const DISTRIBUTION_RESERVE_MAX = 50;
/** Вес и приоритет аккаунта: целые от 1 до этого числа. */
export const DISTRIBUTION_RANK_MAX = 100;

/** Сколько суток новый аккаунт набирает силу; потом действует потолок из тарифа. */
export const WARMUP_DAYS = 28;

/**
 * Сколько суток аккаунт может молчать, не теряя прогрева. Дольше — прогрев начинается заново (ADR-0078, ревизия
 * 2026-10-18): «спящий» аккаунт, которому вдруг дали поток, рискует так же, как новый.
 */
export const WARMUP_IDLE_DAYS = 14;
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
