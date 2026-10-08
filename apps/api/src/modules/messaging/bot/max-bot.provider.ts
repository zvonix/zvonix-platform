/**
 * API ботов MAX (platform-api.max.ru): токен бота в заголовке `Authorization`, без слова Bearer
 * ([docs/api/max-bots.md](../../../../../../docs/api/max-bots.md)).
 *
 * Каждый вызов с пределом времени (ADR-0003). Адрес API — настройка `bot.api_url`: у платформы он менялся.
 */

import { Inject, Injectable } from '@nestjs/common';
import { dependencyUnavailable } from '@zvonix/shared';
import { APP_LOGGER, type Logger } from '../../../infra/tokens.js';
import { SettingsService } from '../../settings/settings.service.js';
import {
  BotRecipientRejectedError,
  BotTokenRejectedError,
  type BotIdentity,
  type BotProvider,
} from './bot.provider.js';

const TIMEOUT_MS = 10_000;
const UNAVAILABLE = 'MAX временно недоступен — повторите позже';

/** События, которые нужны площадке: человек запустил бота и написал боту. */
const UPDATE_TYPES = ['bot_started', 'message_created'];

class BotHttpError extends Error {
  override readonly name = 'BotHttpError';
  constructor(readonly status: number) {
    super(`HTTP ${String(status)}`);
  }
}

@Injectable()
export class MaxBotProvider implements BotProvider {
  private readonly logger: Logger;

  constructor(
    private readonly settings: SettingsService,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('max-bot');
  }

  async me(token: string): Promise<BotIdentity> {
    try {
      const body = await this.request<{ user_id?: unknown; name?: unknown; username?: unknown }>(
        'GET',
        '/me',
        token,
      );
      if (
        (typeof body.user_id !== 'number' && typeof body.user_id !== 'string') ||
        typeof body.username !== 'string' ||
        body.username === ''
      ) {
        this.logger.warn('MAX не вернул данные бота', { reason: 'shape' });
        throw dependencyUnavailable(UNAVAILABLE);
      }
      return {
        userId: String(body.user_id),
        name: typeof body.name === 'string' ? body.name : body.username,
        username: body.username,
      };
    } catch (cause) {
      if (cause instanceof BotHttpError && cause.status === 401) {
        throw new BotTokenRejectedError('MAX не принял токен бота');
      }
      throw this.unavailable(cause);
    }
  }

  async subscribe(token: string, url: string, secret: string): Promise<void> {
    try {
      await this.request('POST', '/subscriptions', token, {
        url,
        update_types: UPDATE_TYPES,
        secret,
      });
    } catch (cause) {
      throw this.unavailable(cause);
    }
  }

  async unsubscribe(token: string, url: string): Promise<void> {
    try {
      await this.request('DELETE', `/subscriptions?url=${encodeURIComponent(url)}`, token);
    } catch (cause) {
      // Подписки уже нет — отписываться не от чего.
      if (cause instanceof BotHttpError && cause.status === 404) return;
      throw this.unavailable(cause);
    }
  }

  async send(
    token: string,
    chatId: string,
    text: string,
    options?: { readonly requestContact?: string },
  ): Promise<{ messageId: string }> {
    try {
      const body = await this.request<{ message?: { body?: { mid?: unknown } } }>(
        'POST',
        `/messages?chat_id=${encodeURIComponent(chatId)}`,
        token,
        {
          text,
          ...(options?.requestContact === undefined
            ? {}
            : {
                attachments: [
                  {
                    type: 'inline_keyboard',
                    payload: {
                      buttons: [[{ type: 'request_contact', text: options.requestContact }]],
                    },
                  },
                ],
              }),
        },
      );
      const mid = body.message?.body?.mid;
      return { messageId: typeof mid === 'string' || typeof mid === 'number' ? String(mid) : '' };
    } catch (cause) {
      // 400/403/404 — получатель недоступен (остановил бота, чат удалён): повтор не поможет.
      if (cause instanceof BotHttpError && [400, 403, 404].includes(cause.status)) {
        throw new BotRecipientRejectedError(`ответ ${String(cause.status)}`);
      }
      throw this.unavailable(cause);
    }
  }

  private unavailable(cause: unknown): Error {
    if (cause instanceof Error && cause.name === 'DomainError') return cause;
    this.logger.warn('API ботов MAX недоступен или ответил отказом', {
      reason: cause instanceof Error ? cause.name : 'unknown',
      ...(cause instanceof BotHttpError ? { status: cause.status } : {}),
    });
    return dependencyUnavailable(UNAVAILABLE);
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token: string,
    body?: unknown,
  ): Promise<T> {
    const { apiUrl } = await this.settings.bot();
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new BotHttpError(response.status);
    return (await response.json()) as T;
  }
}
