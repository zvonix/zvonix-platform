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

  'cabinets.partner_may_add_client': {
    kind: 'boolean',
    fallback: 'true',
    hint: 'Партнёр может подать заявку на кабинет клиента («Стать клиентом»)',
  },

  'cabinets.client_may_add_partner': {
    kind: 'boolean',
    fallback: 'true',
    hint: 'Клиент может подать заявку на кабинет партнёра («Стать партнёром»)',
  },

  'partners.auto_approve': {
    kind: 'boolean',
    fallback: 'false',
    hint:
      'Партнёры получают кабинет и допуск к работе без проверки администратором — сразу после ' +
      'подтверждения почты',
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
