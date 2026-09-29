/**
 * Настройки площадки: чтение с коротким кэшем и запись с журналом
 * ([ADR-0031](../../../../../docs/adr/0031-nastroyki-ploshchadki.md)).
 */

import { Inject, Injectable } from '@nestjs/common';
import { notFound, parseId, validationFailed } from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';
import { decryptSecret, encryptSecret, PLATFORM_SETTING_PURPOSE } from '../../infra/secret-box.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsRepository } from './settings.repository.js';
import {
  isSecret,
  isSettingKey,
  parseSetting,
  serializeSetting,
  SETTING_KEYS,
  SETTINGS,
  type SettingKey,
} from './settings.js';

/**
 * Сколько живёт кэш настроек в процессе.
 *
 * Полминуты. Правка доходит до API и воркера сама, без оповещения между процессами:
 * механизм рассылки изменений ради настройки, которую правят раз в год, — лишний узел,
 * который сломается молча (ADR-0031). Свой процесс видит изменение сразу — кэш сбрасывается
 * при записи.
 */
const CACHE_TTL_MS = 30_000;

/** Что показывается администратору. Секретное значение наружу не выходит никогда. */
export interface SettingView {
  readonly key: string;
  readonly kind: string;
  readonly hint: string;
  readonly secret: boolean;
  /** У секрета — `null`; вместо значения есть признак `is_set`. */
  readonly value: string | number | boolean | null;
  readonly is_set: boolean;
  readonly updated_at: string | null;
}

export interface MailSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly password: string;
  readonly from: string;
}

export interface CaptchaSettings {
  readonly siteKey: string;
  readonly serverKey: string;
  readonly onRegister: boolean;
  readonly onLogin: boolean;
  readonly onPasswordReset: boolean;
}

type Values = Map<SettingKey, string | number | boolean>;

@Injectable()
export class SettingsService {
  private readonly logger: Logger;
  private cache: { values: Values; loadedAt: number } | undefined;

  constructor(
    private readonly repository: SettingsRepository,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('settings');
  }

  async mail(): Promise<MailSettings> {
    const values = await this.values();
    return {
      host: this.text(values, 'mail.host'),
      port: this.number(values, 'mail.port'),
      secure: this.flag(values, 'mail.secure'),
      user: this.text(values, 'mail.user'),
      password: this.text(values, 'mail.password'),
      from: this.text(values, 'mail.from'),
    };
  }

  async captcha(): Promise<CaptchaSettings> {
    const values = await this.values();
    return {
      siteKey: this.text(values, 'captcha.site_key'),
      serverKey: this.text(values, 'captcha.server_key'),
      onRegister: this.flag(values, 'captcha.on_register'),
      onLogin: this.flag(values, 'captcha.on_login'),
      onPasswordReset: this.flag(values, 'captcha.on_password_reset'),
    };
  }

  /**
   * Допуск партнёров без проверки администратором (владелец, 2026-09-29: «чтобы партнёры
   * могли регистрироваться без подтверждения от админа — настройка включать или нет»).
   */
  async partners(): Promise<{ readonly autoApprove: boolean }> {
    const values = await this.values();
    return { autoApprove: this.flag(values, 'partners.auto_approve') };
  }

  /** Полный список для админки: и заданные, и оставшиеся на умолчании. */
  async list(): Promise<SettingView[]> {
    const stored = new Map((await this.repository.list()).map((row) => [row.key, row]));
    const values = await this.values();

    return SETTING_KEYS.map((key) => {
      const secret = isSecret(key);
      const row = stored.get(key);
      return {
        key,
        kind: SETTINGS[key].kind,
        hint: SETTINGS[key].hint,
        secret,
        value: secret ? null : (values.get(key) ?? null),
        is_set: row !== undefined && row.value !== '',
        updated_at: row?.updatedAt.toISOString() ?? null,
      };
    });
  }

  /**
   * Меняет несколько настроек разом.
   *
   * Одной транзакцией вместе с журналом ([ADR-0034](../../../../../docs/adr/0034-zhurnal-deneg-odnoy-tranzakciey.md)):
   * настройка почты и капчи — не деньги, но вопрос «кто выключил капчу» разбирается так же.
   */
  async set(changes: Record<string, unknown>, actorUserId: string): Promise<SettingView[]> {
    const entries = Object.entries(changes);
    if (entries.length === 0) throw validationFailed('Нечего менять');

    const prepared: { key: SettingKey; stored: string; shown: unknown }[] = [];
    for (const [key, value] of entries) {
      if (!isSettingKey(key)) throw notFound(`Неизвестная настройка: «${key}»`);

      const serialized = serializeSetting(key, value);
      if (serialized === undefined) {
        throw validationFailed(
          `Значение не подходит настройке «${key}»: ожидался ${SETTINGS[key].kind}`,
        );
      }

      prepared.push({
        key,
        stored:
          isSecret(key) && serialized !== ''
            ? encryptSecret(serialized, this.config.SECRET_KEY, PLATFORM_SETTING_PURPOSE)
            : serialized,
        // Секрет в журнал не попадает — только факт. Но очистка от замены отличается:
        // иначе «кто очистил пароль почты» читается как `<скрыто>` → `<скрыто>`.
        shown: shownValue(key, serialized),
      });
    }

    const now = new Date();
    const actor = parseId(actorUserId, 'user');

    await this.repository.db.transaction(async (tx) => {
      // «Что было до» читается **той же транзакцией**: вопрос «кто выключил капчу»
      // без прежнего значения отвечается наполовину — видно, кто и на что переключил,
      // но не видно, было ли это изменением вообще.
      const stored = new Map((await this.repository.list(tx)).map((row) => [row.key, row.value]));

      for (const change of prepared) {
        await this.repository.put(
          { key: change.key, value: change.stored, updatedByUserId: actor, at: now },
          tx,
        );
      }

      await this.audit.record(
        {
          action: 'platform_settings.changed',
          entityType: 'platform_settings',
          actorUserId: actor,
          before: Object.fromEntries(
            prepared.map((change) => [
              change.key,
              previousShown(change.key, stored.get(change.key)),
            ]),
          ),
          after: Object.fromEntries(prepared.map((change) => [change.key, change.shown])),
        },
        tx,
      );
    });

    this.cache = undefined;
    this.logger.info('Настройки изменены', { keys: prepared.map((change) => change.key) });
    return this.list();
  }

  /** Сбрасывает кэш: нужен после правки из другого процесса, когда ждать полминуты нельзя. */
  forget(): void {
    this.cache = undefined;
  }

  private async values(): Promise<Values> {
    const fresh = this.cache !== undefined && Date.now() - this.cache.loadedAt < CACHE_TTL_MS;
    if (this.cache !== undefined && fresh) return this.cache.values;

    const values: Values = new Map();
    const stored = new Map((await this.repository.list()).map((row) => [row.key, row.value]));

    for (const key of SETTING_KEYS) {
      const raw = stored.get(key);
      values.set(key, this.decode(key, raw));
    }

    this.cache = { values, loadedAt: Date.now() };
    return values;
  }

  /**
   * Приводит хранимое значение к рабочему.
   *
   * Непонятное значение не роняет площадку: берётся умолчание, а в журнал уходит ошибка.
   * Настройка правится мышью, и опечатка не должна означать, что процесс не поднимется.
   */
  private decode(key: SettingKey, raw: string | undefined): string | number | boolean {
    const fallback = parseSetting(key, SETTINGS[key].fallback) ?? '';
    if (raw === undefined) return fallback;

    let text = raw;
    if (isSecret(key) && raw !== '') {
      try {
        text = decryptSecret(raw, this.config.SECRET_KEY, PLATFORM_SETTING_PURPOSE);
      } catch (cause) {
        // Сменился `SECRET_KEY` или испорчены данные. Молчать нельзя: настройка,
        // которую нельзя прочитать, перестаёт действовать, а человек об этом не узнает.
        this.logger.error('Секретная настройка не расшифрована', cause, { key });
        return fallback;
      }
    }

    const parsed = parseSetting(key, text);
    if (parsed === undefined) {
      this.logger.error('Значение настройки не разобрано: действует умолчание', undefined, {
        key,
        kind: SETTINGS[key].kind,
      });
      return fallback;
    }
    return parsed;
  }

  private text(values: Values, key: SettingKey): string {
    const value = values.get(key);
    return typeof value === 'string' ? value : '';
  }

  private number(values: Values, key: SettingKey): number {
    const value = values.get(key);
    return typeof value === 'number' ? value : 0;
  }

  private flag(values: Values, key: SettingKey): boolean {
    return values.get(key) === true;
  }
}

/**
 * Значение в том виде, в каком его можно положить в журнал.
 *
 * У секрета — только факт: сам он лежит шифротекстом и наружу не отдаётся никогда
 * ([ADR-0031](../../../../../docs/adr/0031-nastroyki-ploshchadki.md)). Но пустое
 * значение секретом не является, и пустоту от заданного отличать надо: иначе очистка
 * пароля почты записывается как `<скрыто>` → `<скрыто>`, то есть ни о чём.
 */
function shownValue(key: SettingKey, raw: string): unknown {
  if (!isSecret(key)) return raw;
  return raw === '' ? '' : '<скрыто>';
}

/**
 * Прежнее значение.
 *
 * Незаданная настройка отличается от заданной пустой: первая действует умолчанием,
 * вторая — пустым значением, и в журнале это разные события. Отсюда `null`, а не `''`.
 */
function previousShown(key: SettingKey, raw: string | undefined): unknown {
  return raw === undefined ? null : shownValue(key, raw);
}
