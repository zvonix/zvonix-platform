/**
 * Проверка «я не робот» на стороне сервера
 * ([ADR-0031](../../../../../docs/adr/0031-nastroyki-ploshchadki.md)).
 *
 * Закрывает три формы, каждая из которых заставляет платформу что-то сделать по просьбе
 * постороннего: регистрация и восстановление пароля отправляют письмо на названный адрес
 * ([ADR-0030](../../../../../docs/adr/0030-predel-pisem-na-adres.md)), вход тратит
 * девятнадцать мегабайт на сверку пароля.
 *
 * Контракт источника проверен по документации Яндекса 2026-09-04: `POST` на
 * `https://smartcaptcha.cloud.yandex.ru/validate`, тело `x-www-form-urlencoded`
 * с полями `secret`, `token` и необязательным `ip`; ответ — JSON с `status` (`ok`
 * либо `failed`) и `message`. Токен живёт пять минут и принимается один раз.
 */

import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { validationFailed } from '@zvonix/shared';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { SettingsService } from '../settings/settings.service.js';

/** Формы, которые капча закрывает. Имя попадает в журнал: видно, где именно сработало. */
export type CaptchaForm = 'register' | 'login' | 'password_reset';

const VALIDATE_URL = 'https://smartcaptcha.cloud.yandex.ru/validate';

/**
 * Предел времени на проверку.
 *
 * Проверка стоит в цепочке входа, и человек всё это время смотрит на крутящийся кружок.
 * Пять секунд — верхняя граница разумного ожидания; дальше пропускаем и поднимаем тревогу.
 */
const REQUEST_TIMEOUT_MS = 5000;

interface ValidationAnswer {
  readonly status?: unknown;
  readonly message?: unknown;
}

@Injectable()
export class CaptchaService {
  private readonly logger: Logger;

  constructor(
    private readonly settings: SettingsService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('captcha');
  }

  /** Что показать форме: ключ страницы и на каких формах проверка включена. */
  async publicState(): Promise<{
    site_key: string;
    register: boolean;
    login: boolean;
    password_reset: boolean;
  }> {
    const captcha = await this.settings.captcha();
    const usable = captcha.siteKey !== '' && captcha.serverKey !== '';
    return {
      site_key: captcha.siteKey,
      register: usable && captcha.onRegister,
      login: usable && captcha.onLogin,
      password_reset: usable && captcha.onPasswordReset,
    };
  }

  /**
   * Пропускает запрос дальше либо отказывает.
   *
   * **Недоступна проверка — пропускаем и поднимаем тревогу.** Тот же довод, что
   * у счётчика ограничений частоты: отказ на этом месте закрыл бы вход всем, включая
   * администратора, которому и предстоит это чинить. Цена — во время недоступности
   * формы защищены только пределом частоты.
   */
  async assertHuman(
    form: CaptchaForm,
    token: string | undefined,
    ip: string | null,
  ): Promise<void> {
    const captcha = await this.settings.captcha();
    if (!this.enabledFor(form, captcha)) return;

    if (captcha.serverKey === '') {
      // Включена, но проверять нечем. Не отказ: иначе опечатка в настройке закрывает
      // вход в систему, а починить его можно только войдя.
      this.logger.error(
        'Капча включена, но серверный ключ не задан: проверка пропущена',
        undefined,
        {
          form,
          setting: 'captcha.server_key',
        },
      );
      return;
    }

    if (token === undefined || token === '') {
      throw validationFailed('Не пройдена проверка «я не робот»', {
        details: { field: 'captchaToken' },
      });
    }

    const verdict = await this.validate(captcha.serverKey, token, ip, form);
    if (verdict === 'unavailable') return;
    if (verdict === 'failed') {
      // Одинаковый ответ и роботу, и человеку с истёкшим токеном: различать их
      // наружу незачем, а разница подсказывала бы, как подбирать.
      throw validationFailed('Проверка «я не робот» не пройдена, попробуйте ещё раз', {
        details: { field: 'captchaToken' },
      });
    }
  }

  private enabledFor(
    form: CaptchaForm,
    captcha: { onRegister: boolean; onLogin: boolean; onPasswordReset: boolean },
  ): boolean {
    if (form === 'register') return captcha.onRegister;
    if (form === 'login') return captcha.onLogin;
    return captcha.onPasswordReset;
  }

  private async validate(
    secret: string,
    token: string,
    ip: string | null,
    form: CaptchaForm,
  ): Promise<'ok' | 'failed' | 'unavailable'> {
    const body = new URLSearchParams({ secret, token });
    // Адрес источника передаётся, когда он известен: без него проверка теряет часть
    // признаков, а `request.ip` у нас уже очищен от подделки через X-Forwarded-For.
    if (ip !== null) body.set('ip', ip);

    try {
      const response = await fetch(VALIDATE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.error('Сервис капчи ответил отказом: проверка пропущена', undefined, {
          form,
          status: response.status,
        });
        return 'unavailable';
      }

      const answer = (await response.json()) as ValidationAnswer;
      if (answer.status === 'ok') return 'ok';
      if (answer.status === 'failed') {
        this.logger.info('Капча не пройдена', { form, message: describe(answer.message) });
        return 'failed';
      }

      // Ответ есть, но не тот, что описан в контракте: считать его провалом нельзя —
      // так сменившийся формат закрыл бы вход всем.
      this.logger.error('Сервис капчи ответил непонятным: проверка пропущена', undefined, {
        form,
        status: describe(answer.status),
      });
      return 'unavailable';
    } catch (cause) {
      this.logger.error('Сервис капчи недоступен: проверка пропущена', cause, { form });
      return 'unavailable';
    }
  }
}

/**
 * Поле чужого ответа для журнала.
 *
 * Приводится только то, что приводится осмысленно: источник может прислать что угодно,
 * а `[object Object]` в журнале не говорит ничего.
 */
function describe(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
