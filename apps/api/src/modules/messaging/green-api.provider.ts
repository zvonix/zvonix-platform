/**
 * Провайдер доступа к MAX — Green API
 * ([ADR-0071](../../../../../docs/adr/0071-soobscheniya-max.md)).
 *
 * Единственное место, где это имя встречается. Наружу отдаётся только наш интерфейс: ошибки
 * провайдера пересказываются нашими словами, а подробность (код ответа, текст) — в журнал площадки.
 *
 * Каждый вызов с пределом времени (ADR-0003): медленный провайдер не должен держать запрос кабинета.
 */

import { Inject, Injectable } from '@nestjs/common';
import { dependencyUnavailable, type MessengerProviderId } from '@zvonix/shared';
import { APP_LOGGER, type Logger } from '../../infra/tokens.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  RecipientRejectedError,
  type AccessCheck,
  type MessageProvider,
  type ProviderAccountRef,
  type ProviderState,
  type QrResult,
} from './provider.js';

const TIMEOUT_MS = 10_000;

const UNAVAILABLE = 'Мессенджер временно недоступен — повторите позже';

/** Состояния провайдера → наши: незнакомое состояние не считается ни рабочим, ни сломанным. */
const STATES: Record<string, ProviderState> = {
  authorized: 'authorized',
  notAuthorized: 'not_authorized',
  blocked: 'blocked',
  starting: 'starting',
  sleepMode: 'starting',
  yellowCard: 'blocked',
};

@Injectable()
export class GreenApiMessageProvider implements MessageProvider {
  readonly id: MessengerProviderId = 'green_api';
  private readonly logger: Logger;

  constructor(
    private readonly settings: SettingsService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('messenger-provider');
  }

  async checkAccess(): Promise<AccessCheck> {
    const { partnerUrl, partnerToken } = await this.settings.messaging();
    if (partnerToken === '') return { state: 'no_key' };
    try {
      const body = await this.request<unknown>(
        'GET',
        `${partnerUrl}/partner/getInstances/${encodeURIComponent(partnerToken)}`,
      );
      return { state: 'ok', instances: Array.isArray(body) ? body.length : 0 };
    } catch (cause) {
      this.unavailable(cause);
      const refused =
        cause instanceof ProviderHttpError && cause.status >= 400 && cause.status < 500;
      return { state: refused ? 'rejected' : 'unreachable' };
    }
  }

  async createAccount(): Promise<ProviderAccountRef> {
    const { partnerUrl, partnerToken } = await this.settings.messaging();
    if (partnerToken === '') {
      throw dependencyUnavailable('Автоматическое заведение аккаунтов не настроено', {
        details: { remedy: 'Администратор заводит аккаунт вручную.' },
      });
    }
    const body = await this.call<{
      idInstance?: number | string;
      apiTokenInstance?: string;
      apiUrl?: string;
    }>('POST', `${partnerUrl}/partner/createInstance/${encodeURIComponent(partnerToken)}`, {});
    if (body.idInstance === undefined || body.apiTokenInstance === undefined) {
      this.logger.error('Провайдер не вернул данные инстанса', undefined, { reason: 'shape' });
      throw dependencyUnavailable(UNAVAILABLE);
    }
    return {
      instanceId: String(body.idInstance),
      token: body.apiTokenInstance,
      apiUrl: (body.apiUrl ?? partnerUrl).replace(/\/+$/u, ''),
    };
  }

  async qr(ref: ProviderAccountRef): Promise<QrResult> {
    const body = await this.call<{ type?: string; message?: string }>(
      'GET',
      `${this.base(ref)}/qr/${encodeURIComponent(ref.token)}`,
    );
    if (body.type === 'qrCode' && typeof body.message === 'string') {
      return { kind: 'qr', image: body.message };
    }
    if (body.type === 'alreadyLogged' || body.type === 'already_registered') {
      return { kind: 'authorized' };
    }
    return { kind: 'unavailable' };
  }

  async state(ref: ProviderAccountRef): Promise<{ state: ProviderState; phone: string | null }> {
    const body = await this.call<{ stateInstance?: string }>(
      'GET',
      `${this.base(ref)}/getStateInstance/${encodeURIComponent(ref.token)}`,
    );
    const state = STATES[body.stateInstance ?? ''] ?? 'unknown';
    if (state !== 'authorized') return { state, phone: null };

    // Номер нужен для показа партнёру; не получился — аккаунт от этого не становится нерабочим.
    try {
      const settings = await this.call<{ wid?: string }>(
        'GET',
        `${this.base(ref)}/getSettings/${encodeURIComponent(ref.token)}`,
      );
      const digits = (settings.wid ?? '').replace(/@.*$/u, '').replace(/\D/gu, '');
      return { state, phone: digits === '' ? null : digits };
    } catch {
      return { state, phone: null };
    }
  }

  async deleteAccount(ref: ProviderAccountRef): Promise<void> {
    const { partnerUrl, partnerToken } = await this.settings.messaging();
    if (partnerToken === '') return;
    await this.call(
      'POST',
      `${partnerUrl}/partner/deleteInstanceAccount/${encodeURIComponent(partnerToken)}`,
      { idInstance: Number(ref.instanceId) },
    );
  }

  async sendText(
    ref: ProviderAccountRef,
    recipient: string,
    text: string,
  ): Promise<{ messageId: string }> {
    try {
      const body = await this.request<{ idMessage?: string }>(
        'POST',
        `${this.base(ref)}/sendMessage/${encodeURIComponent(ref.token)}`,
        { chatId: `${recipient}@c.us`, message: text },
      );
      if (typeof body.idMessage !== 'string' || body.idMessage === '') {
        this.logger.warn('Провайдер не вернул идентификатор сообщения', { reason: 'shape' });
        throw dependencyUnavailable(UNAVAILABLE);
      }
      return { messageId: body.idMessage };
    } catch (cause) {
      // 400/404/422 — получатель негоден (нет аккаунта в MAX): повтор не поможет. 403 (аккаунт
      // ограничен), 429 (частота) и всё прочее — временное: сообщение остаётся в очереди.
      if (cause instanceof ProviderHttpError && [400, 404, 422].includes(cause.status)) {
        throw new RecipientRejectedError(`ответ ${String(cause.status)}`);
      }
      throw this.unavailable(cause);
    }
  }

  async configureWebhook(ref: ProviderAccountRef, url: string): Promise<void> {
    await this.call('POST', `${this.base(ref)}/setSettings/${encodeURIComponent(ref.token)}`, {
      webhookUrl: url,
      outgoingMessageWebhook: 'yes',
      stateWebhook: 'yes',
      incomingWebhook: 'no',
    });
  }

  private base(ref: ProviderAccountRef): string {
    return `${ref.apiUrl}/waInstance${encodeURIComponent(ref.instanceId)}`;
  }

  /** Один вызов провайдера: сбой превращается в наш отказ без подробностей, подробности — в журнал. */
  private async call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    try {
      return await this.request<T>(method, url, body);
    } catch (cause) {
      throw this.unavailable(cause);
    }
  }

  private unavailable(cause: unknown): Error {
    if (cause instanceof Error && cause.name === 'DomainError') return cause;
    this.logger.warn('Провайдер мессенджера недоступен или ответил отказом', {
      reason: cause instanceof Error ? cause.name : 'unknown',
      ...(cause instanceof ProviderHttpError ? { status: cause.status } : {}),
    });
    return dependencyUnavailable(UNAVAILABLE);
  }

  /** Низкий уровень: код ответа не прячется, чтобы отправка могла отличить «получатель негоден» от сбоя. */
  private async request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new ProviderHttpError(response.status);
    return (await response.json()) as T;
  }
}

/** Ответ провайдера с кодом отказа. Только внутри этого файла: наружу уходят наши ошибки. */
class ProviderHttpError extends Error {
  override readonly name = 'ProviderHttpError';
  constructor(readonly status: number) {
    super(`HTTP ${String(status)}`);
  }
}
