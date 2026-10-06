/**
 * Закрытый список настроек площадки
 * ([ADR-0031](../../../../../docs/adr/0031-nastroyki-ploshchadki.md)).
 *
 * Состав задан здесь, а не произвольными строками в базе: настройка, о которой знает
 * только база, не проверяется ничем и живёт до первой опечатки. Всё, что сюда не попало,
 * остаётся в окружении ([ADR-0002](../../../../../docs/adr/0002-konfiguraciya.md)).
 */

/** Как значение хранится строкой и во что превращается при чтении. */
type SettingKind = 'string' | 'number' | 'boolean';

export interface SettingDefinition {
  readonly kind: SettingKind;
  /** Секрет шифруется в базе и наружу не отдаётся никогда — ни в API, ни в журнале. */
  readonly secret?: true;
  readonly fallback: string;
  /** Пределы числа: за ними значение не принимается. Только у числовых настроек. */
  readonly min?: number;
  readonly max?: number;
  /** Для чего это: попадает в ответ администратору, чтобы поле не требовало догадок. */
  readonly hint: string;
}

/**
 * Все настройки площадки.
 *
 * Умолчания подобраны так, чтобы **свежая установка работала и ничего не рассылала**:
 * почта не настроена (письма копятся — [ADR-0029](../../../../../docs/adr/0029-pochta.md)),
 * капча выключена. Значений из окружения здесь нет намеренно: у одного значения не должно
 * быть двух источников.
 */
export const SETTINGS = {
  'mail.host': { kind: 'string', fallback: '', hint: 'Узел SMTP. Пусто — почта выключена' },
  'mail.port': { kind: 'number', fallback: '587', hint: '587 для STARTTLS, 465 для TLS' },
  'mail.secure': {
    kind: 'boolean',
    fallback: 'false',
    hint: 'Шифрование с первого байта (порт 465)',
  },
  'mail.user': { kind: 'string', fallback: '', hint: 'Имя для входа. Пусто — без входа' },
  'mail.password': { kind: 'string', secret: true, fallback: '', hint: 'Пароль SMTP' },
  'mail.from': {
    kind: 'string',
    fallback: 'Zvonix <no-reply@localhost>',
    hint: 'Отправитель в заголовке письма',
  },

  'captcha.site_key': {
    kind: 'string',
    fallback: '',
    hint: 'Ключ страницы Яндекс SmartCaptcha — публичный',
  },
  'captcha.server_key': {
    kind: 'string',
    secret: true,
    fallback: '',
    hint: 'Серверный ключ Яндекс SmartCaptcha',
  },
  'captcha.on_register': { kind: 'boolean', fallback: 'false', hint: 'Капча при регистрации' },
  'captcha.on_login': { kind: 'boolean', fallback: 'false', hint: 'Капча при входе' },
  'captcha.on_password_reset': {
    kind: 'boolean',
    fallback: 'false',
    hint: 'Капча при восстановлении пароля',
  },

  'pricing.price_bands_enabled': {
    kind: 'boolean',
    fallback: 'true',
    hint: 'Выключено — партнёр назначает любую цену; коридоры сохраняются',
  },

  'cabinets.partner_may_add_client': {
    kind: 'boolean',
    fallback: 'true',
    hint: 'Пункт «Стать клиентом» в меню партнёра',
  },

  'cabinets.client_may_add_partner': {
    kind: 'boolean',
    fallback: 'true',
    hint: 'Пункт «Стать партнёром» в меню клиента',
  },

  'partners.auto_approve': {
    kind: 'boolean',
    fallback: 'false',
    hint: 'Кабинет и допуск к работе сразу после подтверждения почты',
  },

  'clients.auto_approve': {
    kind: 'boolean',
    fallback: 'false',
    hint: 'Кабинет сразу после подтверждения почты. Минус на счёте не разрешён',
  },

  'notifications.low_balance_enabled': {
    kind: 'boolean',
    fallback: 'false',
    hint: 'Письмо клиенту, когда на счёте остаётся мало. Нужна настроенная почта',
  },

  'notifications.low_balance_amount': {
    kind: 'number',
    fallback: '100',
    hint: 'Порог в рублях: письмо уходит, когда «можно потратить» становится меньше',
  },
  'notifications.alerts_enabled': {
    kind: 'boolean',
    fallback: 'false',
    hint: 'Письмо администраторам: узел не на связи, объект почти не соединяет, заявка на пополнение ждёт, на сервере мало диска или памяти, процессор перегружен, сообщения MAX не уходят. Нужна настроенная почта',
  },

  'messaging.enabled': {
    kind: 'boolean',
    fallback: 'false',
    hint: 'Продукт «Сообщения MAX»: партнёры заводят аккаунты, клиенты отправляют. Выключено — раздел для партнёров и клиентов закрыт',
  },
  'messaging.provider_partner_url': {
    kind: 'string',
    fallback: 'https://api.green-api.com',
    hint: 'Адрес партнёрского доступа провайдера мессенджера: по нему площадка сама заводит аккаунты MAX партнёрам',
  },
  'messaging.provider_partner_token': {
    kind: 'string',
    secret: true,
    fallback: '',
    hint: 'Ключ партнёрского доступа провайдера (выдаёт его поддержка). Пусто — аккаунты заводит администратор вручную',
  },
  'messages.pace_seconds': {
    kind: 'number',
    fallback: '3',
    min: 0,
    max: 3600,
    hint: 'Пауза между сообщениями с одного аккаунта MAX, секунд: защита аккаунта от блокировки мессенджером',
  },
  'messages.max_wait_minutes': {
    kind: 'number',
    fallback: '30',
    min: 1,
    max: 1440,
    hint: 'Сколько сообщение ждёт отправки (лимиты, недоступный аккаунт), минут; потом отклоняется с возвратом денег',
  },
  'retention.messages_days': {
    kind: 'number',
    fallback: '30',
    min: 1,
    max: 365,
    hint: 'Сколько суток хранится текст сообщения (персональные данные); потом стирается, а строка с суммами остаётся',
  },

  'nodes.auto_update': {
    kind: 'boolean',
    fallback: 'false',
    hint: 'Узлы сами обновляются до набора площадки, когда он изменился: ждут конца звонков, не чаще раза в полчаса. Выключено — обновление командой zvonix-node-update',
  },

  'security.admin_second_factor_required': {
    kind: 'boolean',
    fallback: 'false',
    hint: 'Администратор без второго фактора после входа может только подключить его. Включайте, когда у всех администраторов есть приложение с кодами',
  },

  'notifications.payment_decision_enabled': {
    kind: 'boolean',
    fallback: 'false',
    hint: 'Письмо клиенту, когда его заявку на пополнение подтвердили или отклонили. Нужна настроенная почта',
  },
  'notifications.partner_suspension_enabled': {
    kind: 'boolean',
    fallback: 'false',
    hint: 'Письмо партнёру, когда его SIM или шлюз отключились из-за отказов сети. Нужна настроенная почта',
  },

  'recordings.record_all': {
    kind: 'boolean',
    fallback: 'true',
    hint: 'Записывать разговоры по всем линиям, даже если запись у линии не отмечена как обязательная. Выключено — пишутся только линии с обязательной записью',
  },

  'retention.recordings_days': {
    kind: 'number',
    fallback: '30',
    min: 1,
    max: 3650,
    hint: 'Сколько суток хранится запись разговора, от 1 до 3650. Действует на записи, принятые после изменения',
  },
  'retention.metrics_days': {
    kind: 'number',
    fallback: '14',
    min: 1,
    max: 90,
    hint: 'Сколько суток хранится история нагрузки серверов, от 1 до 90',
  },

  'payments.manual_instructions': {
    kind: 'string',
    fallback: '',
    hint: 'Реквизиты для пополнения переводом: клиент видит этот текст в заявке. Пусто — приём заявок закрыт',
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(value: string): value is SettingKey {
  return Object.hasOwn(SETTINGS, value);
}

export function isSecret(key: SettingKey): boolean {
  return 'secret' in SETTINGS[key];
}

/**
 * Разобранное значение настройки.
 *
 * Непонятная строка не роняет площадку и не подменяется тихо: возвращается умолчание,
 * а вызывающий пишет предупреждение. Настройка правится мышью, и опечатка в числе
 * не должна означать, что процесс не поднимется.
 */
export function parseSetting(key: SettingKey, raw: string): string | number | boolean | undefined {
  const definition: SettingDefinition = SETTINGS[key];

  if (definition.kind === 'string') return raw;
  if (definition.kind === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Приводит значение к строке для хранения. Отвергает то, что не соответствует виду. */
export function serializeSetting(key: SettingKey, value: unknown): string | undefined {
  const definition: SettingDefinition = SETTINGS[key];

  if (definition.kind === 'string') return typeof value === 'string' ? value.trim() : undefined;
  if (definition.kind === 'boolean') return typeof value === 'boolean' ? String(value) : undefined;

  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}
